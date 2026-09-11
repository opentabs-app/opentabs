#!/usr/bin/env bash
# The website moved. This path no longer ships anything.
#
# opentabs.app and market.opentabs.app — the pages, the marketplace, the
# nginx configs, verify.sh and the full runbook — live in the private site
# repository, checked out beside this one:
#
#     openapps/opentabs-website/        github.com/opentabs-app/opentabs-website
#
# Deploy from there:
#
#     cd ../opentabs-website && ./deploy.sh && ./verify.sh
#
# Left as a stub rather than deleted, because this is the path muscle memory
# and half the documentation still reach for, and a script that silently
# rsynced an empty directory over the live site would be far worse than one
# that refuses and says where to go.
#
# What stays here is the API's own infrastructure — Dockerfile,
# run-market-api.sh, market-api.env.example and nginx/auth.opentabs.app.conf.
# `../opentabs-website/deploy.sh --api` still reaches it, over ssh, from the
# server's clone of this repository.
echo "The site moved to ../opentabs-website — run ./deploy.sh there." >&2
exit 1
