FROM oven/bun:1.2.23
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY *.mjs ./
ENV COLLECTOR_DB=/data/results.sqlite
CMD ["bun", "main.mjs"]
