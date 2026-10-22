package com.tradingcommunity.security;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

import org.apache.http.client.config.RequestConfig;
import org.keycloak.OAuth2Constants;
import org.keycloak.common.util.SecretGenerator;
import org.keycloak.events.Details;
import org.keycloak.events.Event;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventType;
import org.keycloak.events.admin.AdminEvent;
import org.keycloak.http.simple.SimpleHttp;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.UserSessionModel;
import org.keycloak.protocol.oidc.BackchannelLogoutResponse;
import org.keycloak.protocol.oidc.OIDCLoginProtocol;
import org.keycloak.representations.LogoutToken;
import org.keycloak.services.Urls;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.services.managers.ResourceAdminManager;
import org.keycloak.urls.UrlType;
import org.keycloak.util.JsonSerialization;
import org.keycloak.util.TokenUtil;

/**
 * Revokes all app sessions and online Keycloak sessions after sensitive identity changes. Keycloak's built-in
 * logout-sessions required-action flag only logs out other sessions, and account-console
 * credential removal does not use that action, so it is insufficient for this application.
 */
public final class CredentialChangeRevocationProvider implements EventListenerProvider {
    private static final Set<String> CREDENTIAL_TYPES = Set.of("password", "otp");
    private final KeycloakSession session;

    CredentialChangeRevocationProvider(KeycloakSession session) {
        this.session = session;
    }

    @Override
    public void onEvent(Event event) {
        if (event == null || event.getUserId() == null || event.getRealmId() == null) {
            return;
        }
        if (!isSensitiveChange(event.getType(), event.getDetails())) {
            return;
        }
        revokeAllSessions(event.getRealmId(), event.getUserId());
    }

    @SuppressWarnings("deprecation")
    private boolean isSensitiveChange(EventType type, Map<String, String> details) {
        if (type == EventType.UPDATE_PASSWORD || type == EventType.RESET_PASSWORD
                || type == EventType.UPDATE_TOTP || type == EventType.REMOVE_TOTP
                || type == EventType.UPDATE_EMAIL || type == EventType.UPDATE_PROFILE
                || type == EventType.VERIFY_EMAIL) {
            return true;
        }
        if (type != EventType.UPDATE_CREDENTIAL && type != EventType.REMOVE_CREDENTIAL) {
            return false;
        }
        String credentialType = details == null ? null : details.get(Details.CREDENTIAL_TYPE);
        return credentialType != null && CREDENTIAL_TYPES.contains(credentialType.toLowerCase());
    }

    private void revokeAllSessions(String realmId, String userId) {
        try {
            revokeAllSessionsInternal(realmId, userId);
        } catch (RuntimeException | Error failure) {
            session.getTransactionManager().setRollbackOnly();
            throw failure;
        }
    }

    private void revokeAllSessionsInternal(String realmId, String userId) {
        RealmModel realm = session.realms().getRealm(realmId);
        UserModel user = realm == null ? null : session.users().getUserById(realm, userId);
        if (realm == null || user == null) {
            failClosed("Cannot resolve user for credential-change revocation");
        }

        // App sessions may outlive their provider SSO session. Notify each relying
        // party by subject even when no provider/client sessions remain to enumerate.
        revokeApplicationSessions(realm, user);

        List<UserSessionModel> userSessions;
        try (Stream<UserSessionModel> stream = session.sessions().getUserSessionsStream(realm, user)) {
            userSessions = stream.toList();
        }

        for (UserSessionModel userSession : userSessions) {
            BackchannelLogoutResponse response = AuthenticationManager.backchannelLogout(
                    session,
                    realm,
                    userSession,
                    session.getContext().getUri(),
                    session.getContext().getConnection(),
                    session.getContext().getHttpRequest().getHttpHeaders(),
                    true);
            if (response == null || !response.getLocalLogoutSucceeded()) {
                failClosed("Provider session revocation did not complete");
            }
            for (BackchannelLogoutResponse.DownStreamBackchannelLogoutResponse downstream
                    : response.getClientResponses()) {
                if (downstream.isWithBackchannelLogoutUrl()
                        && downstream.getResponseCode().filter(code -> code >= 200 && code < 300).isEmpty()) {
                    failClosed("Application session revocation endpoint did not accept logout");
                }
            }
        }
    }

    private void revokeApplicationSessions(RealmModel realm, UserModel user) {
        List<ClientModel> clients;
        try (Stream<ClientModel> stream = session.clients().getClientsStream(realm)) {
            clients = stream.filter(client -> client.isEnabled()
                    && OIDCLoginProtocol.LOGIN_PROTOCOL.equals(client.getProtocol())
                    && "true".equals(client.getAttribute("trading-community.credential-revocation"))).toList();
        }
        if (clients.isEmpty()) {
            failClosed("No application backchannel is configured for identity-change revocation");
        }
        for (ClientModel client : clients) {
            String backchannelUrl = ResourceAdminManager.getBackchannelLogoutUrl(session, client);
            if (backchannelUrl == null) {
                failClosed("Designated application backchannel is missing for identity-change revocation");
            }
            ClientModel previousClient = session.getContext().getClient();
            try {
                session.getContext().setClient(client);
                LogoutToken token = new LogoutToken();
                token.id(SecretGenerator.getInstance().generateSecureID());
                token.issuedNow();
                token.exp(Instant.now().getEpochSecond() + 120L);
                token.issuer(Urls.realmIssuer(session.getContext().getUri(UrlType.FRONTEND).getBaseUri(), realm.getName()));
                token.addAudience(client.getClientId());
                token.setSubject(user.getId());
                token.putEvents(TokenUtil.TOKEN_BACKCHANNEL_LOGOUT_EVENT, JsonSerialization.createObjectNode());
                // Deliberately omit sid: the RP must revoke every session for sub,
                // including sessions whose provider session has already expired.
                String encoded = session.tokens().encode(token);
                int status = SimpleHttp.create(session)
                        .withRequestConfig(RequestConfig.custom().setRedirectsEnabled(false)
                                .setConnectionRequestTimeout(5000).setConnectTimeout(5000).setSocketTimeout(5000).build())
                        .withMaxConsumedResponseSize(4096)
                        .doPost(backchannelUrl)
                        .param(OAuth2Constants.LOGOUT_TOKEN, encoded).asStatus();
                if (status < 200 || status >= 300) {
                    failClosed("Application subject-wide session revocation endpoint did not accept logout");
                }
            } catch (IOException failure) {
                failClosed("Application subject-wide session revocation endpoint is unavailable");
            } finally {
                session.getContext().setClient(previousClient);
            }
        }
    }

    private void failClosed(String reason) {
        session.getTransactionManager().setRollbackOnly();
        throw new IllegalStateException(reason);
    }

    @Override
    public void onEvent(AdminEvent event, boolean includeRepresentation) {
        if (event == null || event.getError() != null || event.getRealmId() == null) {
            return;
        }
        String path = event.getResourcePath();
        if (path == null) return;
        String operation = event.getOperationType() == null ? "" : event.getOperationType().name();
        String[] segments = path.split("/");
        for (int index = 0; index + 1 < segments.length; index++) {
            if (!"users".equals(segments[index]) || !isUuidLike(segments[index + 1])) continue;
            boolean userUpdate = segments.length == index + 2 && operation.equals("UPDATE");
            if (userUpdate) {
                revokeAllSessions(event.getRealmId(), segments[index + 1]);
                return;
            }
            if (index + 2 >= segments.length) continue;
            String action = segments[index + 2];
            boolean passwordReset = "reset-password".equals(action);
            boolean credentialRemoval = "credentials".equals(action)
                    && segments.length == index + 4
                    && (operation.equals("DELETE") || operation.equals("ACTION"));
            if (passwordReset || credentialRemoval) {
                revokeAllSessions(event.getRealmId(), segments[index + 1]);
                return;
            }
        }
    }

    private boolean isUuidLike(String value) {
        return value != null && value.matches("[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}");
    }

    @Override
    public void close() {}
}
