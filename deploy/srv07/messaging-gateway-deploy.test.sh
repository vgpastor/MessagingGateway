#!/usr/bin/env bash
# Comprueba las salvaguardas de messaging-gateway-deploy.sh sin servidor: docker, curl y flock son stubs.
# Uso: bash deploy/srv07/messaging-gateway-deploy.test.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/app"

sed -e "s|^DIR=.*|DIR=$TMP/app|" -e "s|/run/lock/|$TMP/|" "$HERE/messaging-gateway-deploy.sh" > "$TMP/deploy.sh"
cat > "$TMP/bin/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "$TMP/docker.log"
EOF
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "{\"status\":\"ok\",\"version\":\"$(sed -n 's/^MG_IMAGE_TAG=//p' "$APP_ENV")\"}"
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/flock"
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH" APP_ENV="$TMP/app/.env"

fails=0
# expect <ok|ko> <MG_IMAGE_TAG inicial o vacío> <descripción> -- <entorno y argumentos>
expect() {
  local want=$1 pin=$2 what=$3; shift 4
  printf 'API_KEY=x\n' > "$APP_ENV"
  [[ -n $pin ]] && printf 'MG_IMAGE_TAG=%s\n' "$pin" >> "$APP_ENV"
  : > "$TMP/docker.log"
  local vars=() args=() a
  for a in "$@"; do if [[ $a == *=* ]]; then vars+=("$a"); else args+=("$a"); fi; done
  if env "${vars[@]}" bash "$TMP/deploy.sh" "${args[@]}" > "$TMP/out" 2>&1; then got=ok; else got=ko; fi
  if [[ $got == "$want" ]]; then echo "ok   $what"; else echo "FAIL $what (esperado $want)"; cat "$TMP/out"; fails=$((fails + 1)); fi
}

expect ko ""    "Actions no cruza la 0.6.0 sin pin"            -- SSH_ORIGINAL_COMMAND=0.6.0
expect ko ""    "Actions ignora el override del corte"          -- SSH_ORIGINAL_COMMAND=0.6.0 MG_DEPLOY_CUTOVER=1
expect ok ""    "el corte manual despliega la 0.6.0"            -- MG_DEPLOY_CUTOVER=1 0.6.0
grep -qx 'MG_IMAGE_TAG=0.6.0' "$APP_ENV" || { echo "FAIL el corte no fija MG_IMAGE_TAG"; fails=$((fails + 1)); }
grep -q 'compose up' "$TMP/docker.log" || { echo "FAIL el corte no recrea el contenedor"; fails=$((fails + 1)); }
expect ok 0.6.0 "Actions despliega una versión nueva"           -- SSH_ORIGINAL_COMMAND=0.6.1
grep -qx 'MG_IMAGE_TAG=0.6.1' "$APP_ENV" || { echo "FAIL no actualiza MG_IMAGE_TAG"; fails=$((fails + 1)); }
expect ok 0.6.0 "0.10.0 es posterior a 0.9.0 (orden de versión)" -- SSH_ORIGINAL_COMMAND=0.10.0
expect ok 0.6.1 "la misma versión no hace nada"                 -- SSH_ORIGINAL_COMMAND=0.6.1
[[ ! -s $TMP/docker.log ]] || { echo "FAIL la misma versión llama a docker"; fails=$((fails + 1)); }
expect ko 0.7.0 "Actions no vuelve atrás"                       -- SSH_ORIGINAL_COMMAND=0.6.9
expect ok 0.7.0 "un root sí puede volver atrás"                 -- MG_DEPLOY_CUTOVER=1 0.6.9
expect ko 0.6.0 "rechaza lo que no es X.Y.Z"                    -- "SSH_ORIGINAL_COMMAND=0.7.0; rm -rf /"
expect ko 0.6.0 "rechaza la versión vacía"                      -- SSH_ORIGINAL_COMMAND=

[[ $fails == 0 ]] && echo "Todo OK" || { echo "$fails fallos"; exit 1; }
