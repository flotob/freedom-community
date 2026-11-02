# antd (https://github.com/freedom-hq/ant): a Swarm light node with a Bee-compatible HTTP API.
# The release and its checksum are pinned; bump both together (see README.md).

FROM debian:bookworm-slim AS fetch
ARG ANT_VERSION=v0.5.77
ARG ANT_SHA256=27d8990f97b95c02040a52872344a146ad9193503b556e9410cee96d10d2a56d
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/antd.tar.gz \
      "https://github.com/freedom-hq/ant/releases/download/${ANT_VERSION}/antd-${ANT_VERSION}-linux-amd64.tar.gz" \
 && echo "${ANT_SHA256}  /tmp/antd.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/antd.tar.gz -C /usr/local/bin antd \
 && /usr/local/bin/antd --version

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home --home-dir /home/ant ant \
 && mkdir -p /home/ant/.antd \
 && chown ant:ant /home/ant/.antd
COPY --from=fetch /usr/local/bin/antd /usr/local/bin/antd
# Doorbell keeper (workaround for the GSOC lurker issue); run as a scheduled task, see keeper.sh.
COPY --chmod=755 keeper.sh /usr/local/bin/ant-keeper
USER ant
WORKDIR /home/ant
# Mount a persistent volume here: it holds the node key (signing.key), chequebook.json and the chunk cache.
VOLUME ["/home/ant/.antd"]
EXPOSE 1633

# GNOSIS_RPC_URL comes from the environment, because keyed RPC URLs are secrets.
# Wallet history scans (eth_getLogs) stay on antd's public default (GNOSIS_LOGS_RPC_URL),
# because keyed free tiers often cap log ranges.
# The API listens on all interfaces inside the container. Don't publish it on the host:
# the steward reaches it over the Docker network, and operators use an SSH tunnel to the container.
ENTRYPOINT ["antd"]
CMD ["--data-dir=/home/ant/.antd", \
     "--api-addr=0.0.0.0:1633", \
     "--disk-cache-max-gb=3", \
     "--chequebook-deposit-plur=20000000000000000", \
     "--log-level=info"]
