package com.tradingcommunity.security;

import org.keycloak.Config;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventListenerProviderFactory;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

/** Registers the listener that invalidates app sessions after password/MFA changes. */
public final class CredentialChangeRevocationProviderFactory implements EventListenerProviderFactory {
    public static final String ID = "trading-community-credential-revocation";

    @Override
    public EventListenerProvider create(KeycloakSession session) {
        return new CredentialChangeRevocationProvider(session);
    }

    @Override
    public void init(Config.Scope config) {}

    @Override
    public void postInit(KeycloakSessionFactory factory) {}

    @Override
    public void close() {}

    @Override
    public String getId() {
        return ID;
    }
}
