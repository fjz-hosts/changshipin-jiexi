#!/bin/sh
set -eu

export NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'
npm ci --omit=dev --registry='https://registry.npmjs.org/'

rm -rf dist
mkdir -p dist
cp -R src public package.json package-lock.json run.sh dist/
cp -R node_modules dist/node_modules
chmod 755 dist/run.sh
