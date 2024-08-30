FROM oven/bun
WORKDIR /usr/src/app
COPY src/ ./src/
COPY assets/ ./assets/
COPY package.json bun.lockb .env jsconfig.json ./
RUN bun install

CMD [ "bun", "start" ]
