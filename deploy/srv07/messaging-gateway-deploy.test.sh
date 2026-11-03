#!/usr/bin/env bash
# Comprueba las salvaguardas de messaging-gateway-deploy.sh sin servidor: docker, curl, flock y sleep son stubs.
# Uso: bash deploy/srv07/messaging-gateway-deploy.test.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/app"

sed -e "s|^APP_DIR=.*|APP_DIR=$TMP/app|" -e "s|^LOG=.*|LOG=$TMP/deploy.log|" -e "s|/run/lock/|$TMP/|" \
  -e "s|^HEALTH_TIMEOUT_S=[0-9]*|HEALTH_TIMEOUT_S=1|" "$HERE/messaging-gateway-deploy.sh" > "$TMP/deploy.sh"
# Si el script cambia y el sed deja de casar, el test escribiría en las rutas reales del servidor o esperaría 30 min.
grep -q "^APP_DIR=$TMP/app" "$TMP/deploy.sh" && grep -q "^LOG=$TMP/" "$TMP/deploy.sh" \
  && grep -q "^HEALTH_TIMEOUT_S=1 " "$TMP/deploy.sh" && ! grep -q /run/lock "$TMP/deploy.sh" \
  || { echo "el sed del test ya no casa con el script"; exit 1; }

cat > "$TMP/bin/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "$TMP/docker.log"
EOF
# El health informa STUB_HEALTH_VERSION si se da; si no, lo que diga el pin (despliegue sano).
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "{\"status\":\"ok\",\"version\":\"${STUB_HEALTH_VERSION:-$(sed -n 's/^MG_IMAGE_TAG=//p' "$APP_ENV")}\"}"
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/flock"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/sleep"
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH" APP_ENV="$TMP/app/.env"

fails=0
check() { local what=$1; shift; if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fails=$((fails + 1)); fi; }

# run <MG_IMAGE_TAG inicial o vacío> [VAR=valor...] [versión]: los argumentos con '=' van al entorno, el resto al script.
run() {
  local pin=$1 vars=() args=() a; shift
  printf 'API_KEY=x\n' > "$APP_ENV"
  [[ -n $pin ]] && printf 'MG_IMAGE_TAG=%s\n' "$pin" >> "$APP_ENV"
  : > "$TMP/docker.log"
  for a in "$@"; do if [[ $a == *=* ]]; then vars+=("$a"); else args+=("$a"); fi; done
  env "${vars[@]}" bash "$TMP/deploy.sh" "${args[@]}" > "$TMP/out" 2>&1
}
ok() { local what=$1; shift; check "$what" run "$@"; }
not() { ! "$@"; }
ko() { local what=$1; shift; check "$what" not run "$@"; }
pinned() { grep -qx "MG_IMAGE_TAG=$1" "$APP_ENV"; }
recreated() { grep -q 'compose up -d gateway' "$TMP/docker.log"; }

ko "Actions no despliega sin pin"                        ""    SSH_ORIGINAL_COMMAND=0.6.0
ko "Actions no cruza la 0.6.0 desde un pin anterior"     0.5.1 SSH_ORIGINAL_COMMAND=0.6.0
ko "Actions no cruza la 0.6.0 saltándosela"              0.5.1 SSH_ORIGINAL_COMMAND=0.7.0
ko "Actions ignora el override"                          0.5.1 SSH_ORIGINAL_COMMAND=0.6.0 MG_DEPLOY_FORCE=1
ko "un MG_IMAGE_TAG del entorno no cambia el pin"        0.5.1 SSH_ORIGINAL_COMMAND=0.6.0 MG_IMAGE_TAG=0.6.0
ok "Actions avanza por debajo del suelo"                 0.5.1 SSH_ORIGINAL_COMMAND=0.5.2
ok "el corte manual cruza la 0.6.0"                      0.5.1 MG_DEPLOY_FORCE=1 0.6.0
check "el corte fija el pin" pinned 0.6.0
check "el corte recrea el contenedor" recreated
ok "Actions avanza tras el corte"                        0.6.0 SSH_ORIGINAL_COMMAND=0.6.1
check "actualiza el pin" pinned 0.6.1
ok "0.10.0 va después de 0.9.0"                          0.9.0 SSH_ORIGINAL_COMMAND=0.10.0
ok "la misma versión se recrea y se comprueba"           0.6.1 SSH_ORIGINAL_COMMAND=0.6.1
check "la misma versión pasa por compose up" recreated
ko "la misma versión con el health en otra falla"        0.6.1 SSH_ORIGINAL_COMMAND=0.6.1 STUB_HEALTH_VERSION=0.6.0
ko "falla si el health no informa la versión nueva"      0.6.0 SSH_ORIGINAL_COMMAND=0.6.1 STUB_HEALTH_VERSION=0.6.0
ko "Actions no vuelve atrás"                             0.7.0 SSH_ORIGINAL_COMMAND=0.6.9
ok "un root sí puede volver atrás"                       0.7.0 MG_DEPLOY_FORCE=1 0.6.9
ko "rechaza lo que no es X.Y.Z"                          0.6.0 "SSH_ORIGINAL_COMMAND=0.7.0; rm -rf /"
ko "rechaza la versión vacía"                            0.6.0 SSH_ORIGINAL_COMMAND=

printf 'API_KEY=x\nSECRET=abc' > "$APP_ENV" # sin salto de línea final
MG_DEPLOY_FORCE=1 bash "$TMP/deploy.sh" 0.6.0 > "$TMP/out" 2>&1 || true
check "el pin no se pega a la última línea de .env" grep -qx 'SECRET=abc' "$APP_ENV"

[[ $fails == 0 ]] && echo "Todo OK" || { echo "$fails fallos"; exit 1; }
