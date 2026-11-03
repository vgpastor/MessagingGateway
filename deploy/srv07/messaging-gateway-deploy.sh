#!/usr/bin/env bash
# Despliegue del gateway en srv07. Es el ÚNICO comando que puede ejecutar la clave de GitHub Actions
# (command= en /root/.ssh/authorized_keys). Instalación, como root y desde el repo:
#   install -m 755 -o root -g root deploy/srv07/messaging-gateway-deploy.sh /usr/local/sbin/messaging-gateway-deploy
# Actions lo llama con la versión como único argumento: `ssh root@srv07 0.7.0` → SSH_ORIGINAL_COMMAND=0.7.0.
#
# La versión desplegada vive en MG_IMAGE_TAG de /opt/messaging-gateway/.env, que lee el compose
# (image: vgpastor/messaging-gateway:${MG_IMAGE_TAG:-latest}). Desde Actions solo se avanza o se redespliega la misma.
#
# Interruptor del corte: cruzar MIGRATION_FLOOR (la 0.6.0 aplica la migración 002, unos 200 s de parada) o desplegar
# sin pin no se hace desde Actions. Lo lanza a mano un root, mejor dentro de tmux:
#   MG_DEPLOY_FORCE=1 messaging-gateway-deploy 0.6.0
# MG_DEPLOY_FORCE salta las dos guardas: cruzar el suelo y volver a una versión anterior.
#
# ponytail: sin rollback automático; si el health falla el job queda en rojo y se vuelve atrás a mano
# (MG_DEPLOY_FORCE=1 messaging-gateway-deploy <versión anterior>, si sus migraciones lo permiten).
set -euo pipefail
export LC_ALL=C
# El entorno manda sobre .env en compose: que solo cuente el pin del fichero.
unset MG_IMAGE_TAG

APP_DIR=/opt/messaging-gateway
ENV_FILE=$APP_DIR/.env
IMAGE=vgpastor/messaging-gateway
MIGRATION_FLOOR=0.6.0
HEALTH_URL=http://127.0.0.1:32768/health # puerto que publica el compose de srv07
HEALTH_TIMEOUT_S=1800                    # las migraciones corren antes de que el gateway escuche
LOG=/var/log/messaging-gateway-deploy.log

fail() { echo "ERROR: $*" >&2; exit 1; }
# a <= b en orden de versión
version_le() { printf '%s\n' "$1" "$2" | sort -V -C; }

# Si se cae el SSH, el despliegue sigue: la salida va también al log y tee no muere por el pipe roto.
trap '' HUP PIPE
exec > >(tee -p -a "$LOG") 2>&1

exec 9>/run/lock/messaging-gateway-deploy.lock
flock -n 9 || fail "ya hay un despliegue en curso"

VERSION=${SSH_ORIGINAL_COMMAND:-${1:-}}
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "versión no válida: '$VERSION' (se espera X.Y.Z)"
echo "== $(date -Is) despliegue de $VERSION =="

# El override solo vale a mano: por la clave de Actions siempre llega SSH_ORIGINAL_COMMAND.
FORCE=false
[[ -z ${SSH_ORIGINAL_COMMAND:-} && ${MG_DEPLOY_FORCE:-} == 1 ]] && FORCE=true

CURRENT=$(sed -n 's/^MG_IMAGE_TAG=//p' "$ENV_FILE" | tail -n1 | tr -d '"'"'"'\r ')
if [[ -z $CURRENT ]]; then
  $FORCE || fail "sin MG_IMAGE_TAG en $ENV_FILE no se sabe qué corre: el primer despliegue se hace a mano (MG_DEPLOY_FORCE=1)."
elif version_le "$MIGRATION_FLOOR" "$VERSION" && ! version_le "$MIGRATION_FLOOR" "$CURRENT"; then
  $FORCE || fail "de la $CURRENT a la $VERSION se cruza la $MIGRATION_FLOOR (migración 002): se hace a mano en el corte (MG_DEPLOY_FORCE=1)."
elif ! version_le "$CURRENT" "$VERSION"; then
  $FORCE || fail "la $VERSION es anterior a la desplegada ($CURRENT): solo se avanza."
fi

cd "$APP_DIR"
if [[ $VERSION != "$CURRENT" ]]; then
  echo "== pull $IMAGE:$VERSION (desplegada: ${CURRENT:-sin pin}) =="
  docker pull -q "$IMAGE:$VERSION"
  sed -i '/^MG_IMAGE_TAG=/d' "$ENV_FILE"
  [[ -z $(tail -c1 "$ENV_FILE") ]] || echo >> "$ENV_FILE"
  printf 'MG_IMAGE_TAG=%s\n' "$VERSION" >> "$ENV_FILE"
fi

# Con la misma versión también se recrea si hace falta y se comprueba: un reintento no da verde a ciegas.
echo "== up =="
docker compose up -d gateway

echo "== health (hasta ${HEALTH_TIMEOUT_S}s) =="
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
until HEALTH=$(curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null) && [[ $HEALTH == *"\"version\":\"$VERSION\""* ]]; do
  ((SECONDS < deadline)) || fail "el health no informa la $VERSION tras ${HEALTH_TIMEOUT_S}s: ${HEALTH:-sin respuesta}"
  sleep 5
done
echo "Despliegue OK: $HEALTH"

# Disco compartido: solo se queda la imagen desplegada; para volver atrás se baja otra vez del Hub.
for tag in $(docker image ls "$IMAGE" --format '{{.Tag}}' | grep -vxF -e "$VERSION" -e '<none>'); do
  echo "borro $IMAGE:$tag"
  docker image rm "$IMAGE:$tag" >/dev/null || echo "no se pudo borrar $IMAGE:$tag" >&2
done
