#!/usr/bin/env bash
# Despliegue del gateway en srv07. Se instala como /usr/local/sbin/messaging-gateway-deploy (root:root, 755)
# y es el ÚNICO comando que puede ejecutar la clave de GitHub Actions (command= en /root/.ssh/authorized_keys).
# Actions lo llama con la versión como único argumento: `ssh root@srv07 0.7.0` → SSH_ORIGINAL_COMMAND=0.7.0.
#
# La versión desplegada vive en MG_IMAGE_TAG de /opt/messaging-gateway/.env, que lee el compose
# (image: vgpastor/messaging-gateway:${MG_IMAGE_TAG:-latest}). Solo avanza: una versión igual o anterior no se toca.
#
# Interruptor del corte: sin MG_IMAGE_TAG el servidor sigue en la imagen `latest` antigua (0.5.x), y el salto a
# >= 0.6.0 aplica la migración 002 (unos 200 s de parada). Ese salto no lo hace Actions: lo lanza a mano un root
# en el corte, con MG_DEPLOY_CUTOVER=1 messaging-gateway-deploy 0.6.0. Desde ahí el CD funciona solo.
#
# ponytail: sin rollback automático; si el health falla el job queda en rojo y se vuelve atrás a mano
# (MG_DEPLOY_CUTOVER=1 messaging-gateway-deploy <versión anterior>, si sus migraciones lo permiten).
set -euo pipefail

DIR=/opt/messaging-gateway
ENV_FILE=$DIR/.env
IMAGE=vgpastor/messaging-gateway
HEALTH_URL=http://127.0.0.1:32768/health

fail() { echo "ERROR: $*" >&2; exit 1; }

exec 9>/run/lock/messaging-gateway-deploy.lock
flock -n 9 || fail "ya hay un despliegue en curso"

VERSION=${SSH_ORIGINAL_COMMAND:-${1:-}}
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "versión no válida: '$VERSION' (se espera X.Y.Z)"

# El override solo vale a mano: por la clave de Actions siempre llega SSH_ORIGINAL_COMMAND y sshd no acepta su entorno.
MANUAL_OVERRIDE=false
[[ -z ${SSH_ORIGINAL_COMMAND:-} && ${MG_DEPLOY_CUTOVER:-} == 1 ]] && MANUAL_OVERRIDE=true

CURRENT=$(sed -n 's/^MG_IMAGE_TAG=//p' "$ENV_FILE" | tail -n1)
if [[ -z $CURRENT ]]; then
  $MANUAL_OVERRIDE || fail "sin MG_IMAGE_TAG en $ENV_FILE: el servidor sigue en la imagen previa a la 0.6.0 y el salto aplica la migración 002. Se hace a mano en el corte (MG_DEPLOY_CUTOVER=1 $0 $VERSION)."
elif [[ $VERSION == "$CURRENT" ]]; then
  echo "La $VERSION ya está desplegada: nada que hacer."; exit 0
elif [[ $(printf '%s\n' "$CURRENT" "$VERSION" | sort -V | tail -n1) != "$VERSION" ]]; then
  $MANUAL_OVERRIDE || fail "la $VERSION es anterior a la desplegada ($CURRENT): solo se avanza."
fi

cd "$DIR"
echo "== pull $IMAGE:$VERSION (desplegada: ${CURRENT:-latest}) =="
docker pull -q "$IMAGE:$VERSION"

if grep -q '^MG_IMAGE_TAG=' "$ENV_FILE"; then
  sed -i "s/^MG_IMAGE_TAG=.*/MG_IMAGE_TAG=$VERSION/" "$ENV_FILE"
else
  printf 'MG_IMAGE_TAG=%s\n' "$VERSION" >> "$ENV_FILE"
fi

echo "== up =="
# --wait espera al healthcheck del contenedor; el límite cubre migraciones largas.
docker compose up -d --wait --wait-timeout 900 gateway

echo "== health =="
HEALTH=$(curl -fsS -m 5 "$HEALTH_URL") || fail "el health no responde"
[[ $HEALTH == *"\"version\":\"$VERSION\""* ]] || fail "el health no informa la $VERSION: $HEALTH"
echo "Despliegue OK: $HEALTH"

# Disco compartido: se quedan la versión nueva y la anterior (para volver atrás); el resto de etiquetas se borra.
docker image ls "$IMAGE" --format '{{.Tag}}' | grep -vxF -e "$VERSION" -e "${CURRENT:-latest}" \
  | xargs -r -I{} docker image rm "$IMAGE:{}" >/dev/null 2>&1 || true
