ARG DENO_VERSION=1.45.3
ARG BIN_IMAGE=denoland/deno:bin-${DENO_VERSION}
FROM ${BIN_IMAGE} AS bin
FROM frolvlad/alpine-glibc:alpine-3.13

RUN apk --no-cache add ca-certificates
RUN addgroup --gid 1000 deno \
  && adduser --uid 1000 --disabled-password deno --ingroup deno \
  && mkdir /deno-dir/ \
  && chown deno:deno /deno-dir/

ENV DENO_DIR /deno-dir/
ENV DENO_INSTALL_ROOT /usr/local
ARG DENO_VERSION
ENV DENO_VERSION=${DENO_VERSION}

COPY --from=bin /deno /bin/deno

WORKDIR /deno-dir

COPY src/ ./src/
COPY assets/ ./assets/
COPY deno.json deno.lock .env ./

ENTRYPOINT ["/bin/deno", "task"]
CMD ["start"]
