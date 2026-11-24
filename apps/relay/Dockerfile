FROM node:26-bookworm-slim
WORKDIR /app
ADD https://registry.npmjs.org/pnpm/-/pnpm-12.14.0.tgz /tmp/pnpm.tgz
RUN mkdir /opt/pnpm && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1 \
    && chmod +x /opt/pnpm/bin/pnpm.mjs \
    && ln -s /opt/pnpm/bin/pnpm.mjs /usr/local/bin/pnpm \
    && pnpm --version && rm /tmp/pnpm.tgz
COPY packages/relay-tunnel ./packages/relay-tunnel
COPY apps/relay ./apps/relay
RUN node --input-type=module -e 'import fs from "node:fs"; for (const p of ["packages/relay-tunnel/package.json", "apps/relay/package.json"]) { const j = JSON.parse(fs.readFileSync(p)); delete j.devDependencies; if (j.dependencies.ws) j.dependencies.ws = "8.22.0"; fs.writeFileSync(p, JSON.stringify(j)); }' \
    && printf 'packages:\n  - apps/relay\n  - packages/relay-tunnel\n' > pnpm-workspace.yaml \
    && pnpm install --prod --ignore-scripts --no-frozen-lockfile
ENV RELAY_STATE=/data/state.sqlite RELAY_CERT_DIR=/data/certs
EXPOSE 80 443
VOLUME ["/data"]
ENTRYPOINT ["node", "apps/relay/src/cli.ts"]
CMD ["serve"]
