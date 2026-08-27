#!/bin/sh
set -e
# Populate the filter file from the allowlist baked into the image at build time
# (sandbox/Dockerfile.proxy COPYs allowed-domains.txt). A later phase can bind-mount
# a per-role allowlist over /etc/tinyproxy/allowed-domains.txt instead.
cp /etc/tinyproxy/allowed-domains.txt /etc/tinyproxy/filter
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
