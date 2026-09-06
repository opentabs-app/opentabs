# The marketplace API, as one static-ish binary in a small image.
#
# Built on the server rather than cross-compiled from a Mac: the target is
# x86_64 Linux, rusqlite is compiled from bundled C, and "it builds on my
# laptop" is not a claim that survives either of those. The repository is
# public, so `git clone` on the box is the whole supply chain.
#
#   docker build -f deploy/Dockerfile -t opentabs-market-api:prod .
#
# Context is the repository root, because the binary is a workspace member
# and Cargo needs the workspace manifest and the sibling crates it depends
# on.

FROM rust:1-bookworm AS build
WORKDIR /src

# The manifests first, so a change to source code does not re-download and
# re-compile every dependency. The dummy sources exist only to give Cargo
# something to build against while it resolves and compiles the dependency
# graph; they are overwritten in the next layer.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/tabs-core/Cargo.toml crates/tabs-core/
COPY crates/tabs-feedgen/Cargo.toml crates/tabs-feedgen/
COPY crates/tabs-market/Cargo.toml crates/tabs-market/
COPY apps/market-api/Cargo.toml apps/market-api/
RUN set -eux; \
    for c in crates/tabs-core crates/tabs-market crates/tabs-feedgen; do \
      mkdir -p "$c/src" && echo '' > "$c/src/lib.rs"; \
    done; \
    mkdir -p crates/tabs-feedgen/src && echo 'fn main() {}' > crates/tabs-feedgen/src/main.rs; \
    mkdir -p apps/market-api/src && echo 'fn main() {}' > apps/market-api/src/main.rs; \
    cargo build --release -p market-api; \
    rm -rf crates/*/src apps/market-api/src

COPY crates crates
COPY apps/market-api apps/market-api
# Cargo keys on mtime, and a fresh COPY of a file whose stale artefact is
# newer would be skipped. Touching the entry points forces the rebuild that
# actually matters.
RUN set -eux; \
    touch apps/market-api/src/main.rs crates/*/src/lib.rs; \
    cargo build --release -p market-api; \
    strip target/release/market-api

FROM debian:bookworm-slim
# TLS roots: the service fetches the platform's JWKS over https, and without
# these that fetch fails with a certificate error at the exact moment
# somebody first tries to sign in — long after the container looked healthy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Not root. The service writes one SQLite file and reads nothing else.
RUN useradd --system --uid 10001 --home /data market \
 && install -d -o market -g market -m 750 /data
COPY --from=build /src/target/release/market-api /usr/local/bin/market-api

USER market
WORKDIR /data
ENV MARKET_DB=/data/market.sqlite PORT=8095
EXPOSE 8095
ENTRYPOINT ["/usr/local/bin/market-api"]
