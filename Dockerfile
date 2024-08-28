FROM oven/bun
WORKDIR /usr/src/app
COPY src/ ./src/
COPY assets/ ./assets/
COPY package.json bun.lockb .env ./
RUN bun install
COPY . .

CMD [ "bun", "start" ]
