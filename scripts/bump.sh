#!/bin/sh
# Stamp index.html's file links with a timestamp so browsers load fresh copies after each update.
V=$(date +%y%m%d%H%M)
sed -i -E "s#(style\.css|config\.js|app\.js)\?v=[a-z0-9]+#\1?v=$V#g" index.html
