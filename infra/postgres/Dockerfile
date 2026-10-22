FROM postgres:18.6@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336

# Keep this non-executable so the official entrypoint sources it in its shell,
# independent of host bind-mount execute permissions.
COPY --chmod=0644 infra/postgres/init/01-create-roles.sh /docker-entrypoint-initdb.d/01-create-roles.sh
