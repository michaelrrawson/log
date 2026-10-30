#!/bin/sh
# Stamp index.html's file links with the current commit so browsers load fresh copies after each update.
V=$(git rev-parse --short HEAD)
sed -i -E "s#(style\.css|config\.js|app\.js)\?v=[a-z0-9]+#\1?v=$V#g" index.html
