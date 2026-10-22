# Compile against the exact Keycloak server libraries used by the runtime image.
FROM quay.io/keycloak/keycloak:26.8.1@sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244 AS keycloak-libs

FROM eclipse-temurin:21.0.8_9-jdk@sha256:7d1d666ddafac14da0ded6b4b076becf76cf88b31f9d7953a76555cc82f86511 AS provider-build
WORKDIR /build
COPY --from=keycloak-libs /opt/keycloak/lib/lib/main /keycloak-libs
COPY infra/keycloak/provider/src /build/src
RUN mkdir -p /build/classes && \
    javac --release 21 -Xlint:all -Werror -cp '/keycloak-libs/*' -d /build/classes \
      $(find /build/src/main/java -name '*.java' -print) && \
    cp -R /build/src/main/resources/. /build/classes/ && \
    jar --create --file /build/credential-change-revocation.jar -C /build/classes .

FROM quay.io/keycloak/keycloak:26.8.1@sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244 AS runtime
COPY --from=provider-build /build/credential-change-revocation.jar /opt/keycloak/providers/credential-change-revocation.jar
RUN /opt/keycloak/bin/kc.sh build
