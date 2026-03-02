# Plan: Integrar Baileys como proveedor WhatsApp

## Contexto

El proyecto sigue arquitectura hexagonal (DDD). Ya existe un proveedor WhatsApp (`wwebjs-api`) que se conecta a una API HTTP externa. Baileys es diferente: es una **librería nativa de Node.js** que se conecta directamente a WhatsApp Web vía WebSocket, gestionando internamente la sesión, autenticación (QR/pairing code), cifrado Signal, y reconexión.

Esto implica un patrón de adaptador fundamentalmente distinto: Baileys mantiene un **proceso persistente** (socket vivo) vs. los otros adaptadores que son stateless HTTP clients.

### Versión de Baileys

Usaremos **`@whiskeysockets/baileys` v7.0.0-rc.9** (última RC estable en npm). Requiere Node >= 20. El proyecto ya usa ES2022 / NodeNext, compatible.

---

## Paso 1 — Registrar `baileys` como ProviderType

### Archivos a modificar:

**`src/domain/messaging/channel.types.ts`** — Añadir `'baileys'` al union type `ProviderType`:
```typescript
export type ProviderType =
  | 'wwebjs-api'
  | 'evolution-api'
  | 'meta-cloud-api'
  | 'baileys'          // ← nuevo
  | 'telegram-bot-api'
  | ...
```

**`src/infrastructure/config/accounts.schema.ts`** — Añadir `'baileys'` al array `providerTypes`:
```typescript
const providerTypes = [
  'wwebjs-api',
  'evolution-api',
  'meta-cloud-api',
  'baileys',          // ← nuevo
  ...
] as const;
```

**`src/infrastructure/config/env.config.ts`** — Añadir mapeo de credenciales:
```typescript
const PROVIDER_CREDENTIAL_SUFFIXES: Record<string, string> = {
  ...
  'baileys': 'AUTH_DIR',  // Ruta al directorio de auth state
};
```

---

## Paso 2 — Instalar dependencia

```bash
npm install @whiskeysockets/baileys@^7.0.0-rc.9
```

Dependencias transitivas clave que ya trae: `ws`, `pino`, `protobufjs`, `libsignal`. No hay peer deps obligatorias (las opcionales como `sharp`, `jimp`, `link-preview-js` son para generación de thumbnails y link previews, no son necesarias para el core).

---

## Paso 3 — Crear tipos específicos de Baileys

### Nuevo archivo: `src/adapters/whatsapp/baileys/baileys.types.ts`

Definir los tipos para la configuración del socket y los payloads crudos de Baileys:

```typescript
/** Configuración que viene de providerConfig en accounts.yaml */
export interface BaileysProviderConfig {
  authDir?: string;               // Ruta para persistir auth state (default: data/baileys-auth/{accountId})
  printQRInTerminal?: boolean;    // Mostrar QR en terminal (default: true)
  browser?: [string, string, string]; // Identificación de browser [name, platform, version]
  connectTimeoutMs?: number;      // Timeout de conexión (default: 60000)
  retryOnDisconnect?: boolean;    // Reconectar automáticamente (default: true)
  maxRetries?: number;            // Máximo de reintentos (default: 5)
  markOnlineOnConnect?: boolean;  // Aparecer online al conectar (default: true)
}

/** Payload crudo de un mensaje inbound de Baileys */
export interface BaileysInboundPayload {
  messages: unknown[];  // WAMessage[] del proto de Baileys
  type: 'notify' | 'append';
}
```

---

## Paso 4 — Crear el gestor de conexión Baileys (singleton por cuenta)

### Nuevo archivo: `src/adapters/whatsapp/baileys/baileys-socket.manager.ts`

Este es el componente más crítico. Baileys necesita un socket vivo. El manager:

1. **Crea y mantiene** una instancia de `makeWASocket()` por cada cuenta Baileys
2. **Gestiona el auth state** usando `useMultiFileAuthState()` para persistir la sesión
3. **Maneja reconexiones** automáticas según `DisconnectReason`
4. **Emite eventos** que el webhook adapter puede capturar
5. **Expone el socket** para que el messaging adapter pueda enviar mensajes

```typescript
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type BaileysEventMap,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import type { BaileysProviderConfig } from './baileys.types.js';

type MessageHandler = (messages: BaileysEventMap['messages.upsert']) => void;
type ConnectionHandler = (update: BaileysEventMap['connection.update']) => void;

export class BaileysSocketManager {
  private sockets = new Map<string, WASocket>();
  private messageHandlers = new Map<string, MessageHandler>();
  private connectionHandlers = new Map<string, ConnectionHandler>();

  async connect(accountId: string, config: BaileysProviderConfig): Promise<WASocket> { ... }
  getSocket(accountId: string): WASocket | undefined { ... }
  onMessage(accountId: string, handler: MessageHandler): void { ... }
  onConnectionUpdate(accountId: string, handler: ConnectionHandler): void { ... }
  async disconnect(accountId: string): Promise<void> { ... }
  isConnected(accountId: string): boolean { ... }
}
```

Se usará un **singleton global** exportado para que tanto el adapter, el health checker, y el webhook controller compartan la misma instancia.

---

## Paso 5 — Crear el Messaging Adapter

### Nuevo archivo: `src/adapters/whatsapp/baileys/baileys.adapter.ts`

Implementa `MessagingPort`. A diferencia de `wwebjs-api` (HTTP), este usa el socket directo:

```typescript
export class BaileysAdapter implements MessagingPort {
  constructor(
    providerConfig: Record<string, unknown>,
    credentialsRef: string,
    inlineCredential?: string,
  ) {
    // Parsear BaileysProviderConfig desde providerConfig
    // Resolver authDir desde credentialsRef o usar default
  }

  async sendMessage(msg: OutboundMessage): Promise<MessageResult> {
    // 1. Obtener socket del BaileysSocketManager
    // 2. Formatear JID: msg.to → "xxxxx@s.whatsapp.net"
    // 3. Mapear OutboundMessage a llamada Baileys:
    //    - text: sock.sendMessage(jid, { text: body })
    //    - image: sock.sendMessage(jid, { image: { url: mediaUrl }, caption })
    //    - video: sock.sendMessage(jid, { video: { url: mediaUrl }, caption })
    //    - audio: sock.sendMessage(jid, { audio: { url: mediaUrl }, mimetype })
    //    - document: sock.sendMessage(jid, { document: { url: mediaUrl }, fileName, mimetype })
    //    - location: sock.sendMessage(jid, { location: { degreesLatitude, degreesLongitude } })
    //    - reaction: sock.sendMessage(jid, { react: { text: body, key: ... } })
    // 4. Soportar replyToMessageId vía { quoted: ... }
    // 5. Retornar MessageResult con messageId del response.key
  }

  async getMessageStatus(messageId: string): Promise<MessageStatus> {
    // Baileys no tiene API directa de consulta de status por messageId
    // Retornar 'unknown' o implementar tracking vía eventos 'messages.update'
  }

  async downloadMedia(mediaId: string): Promise<MediaContent> {
    // Usar downloadMediaMessage() de Baileys
    // Parsear el WAMessage almacenado y extraer el media
  }

  async markAsRead(messageId: string): Promise<void> {
    // Usar sock.readMessages([{ remoteJid, id, participant }])
  }
}
```

---

## Paso 6 — Crear el Mapper (Baileys → WhatsApp channel types)

### Nuevo archivo: `src/adapters/whatsapp/baileys/baileys.mapper.ts`

Convierte los WAMessage de Baileys a los tipos compartidos `WhatsAppInboundEvent`:

```typescript
export function mapBaileysToWhatsAppEvent(
  message: WAMessage,
): WhatsAppInboundEvent {
  // message.key.remoteJid → from.wid
  // message.key.id → messageId
  // message.pushName → from.pushName
  // message.message → discriminar tipo (conversation, imageMessage, audioMessage, etc.)
  // Mapear a WhatsAppMessage (text, image, audio, video, document, location, contact, reaction, sticker)
}
```

**Importante**: Reutiliza `buildWhatsAppEnvelope()` y `mapWhatsAppEventToContentSummary()` del mapper existente (`wwebjs.mapper.ts`), ya que el output es el mismo `WhatsAppInboundEvent`. Esto garantiza consistencia en el `UnifiedEnvelope`.

---

## Paso 7 — Crear el Webhook Adapter (Inbound)

### Nuevo archivo: `src/adapters/whatsapp/baileys/baileys-webhook.adapter.ts`

Implementa `InboundWebhookPort<BaileysInboundPayload, WhatsAppInboundEvent>`.

**Diferencia clave con wwebjs**: En wwebjs los webhooks vienen como HTTP POST desde un servicio externo. En Baileys, los mensajes llegan como **eventos del socket**. Hay dos opciones:

**Opción elegida: Adapter interno + push al webhook controller**

El `BaileysSocketManager` escucha `messages.upsert`, convierte vía el mapper, y envía internamente al `WebhookForwarder`. No necesita un endpoint HTTP de inbound porque los datos no vienen de fuera.

Sin embargo, para mantener consistencia con la arquitectura, el `BaileysWebhookAdapter` sigue implementando `InboundWebhookPort` para que el mismo código pueda usarse si alguien quiere enviar mensajes Baileys vía HTTP (por ejemplo, en un setup multi-proceso).

```typescript
export class BaileysWebhookAdapter
  implements InboundWebhookPort<BaileysInboundPayload, WhatsAppInboundEvent>
{
  parseIncoming(raw: BaileysInboundPayload): WhatsAppInboundEvent { ... }
  validateSignature(_req: RawRequest): boolean { return true; } // No aplica
  toEnvelope(event: WhatsAppInboundEvent, account: ChannelAccount): UnifiedEnvelope<WhatsAppInboundEvent> {
    return buildWhatsAppEnvelope(event, account);
  }
}
```

---

## Paso 8 — Crear el Health Checker

### Nuevo archivo: `src/adapters/whatsapp/baileys/baileys.health-checker.ts`

```typescript
export class BaileysHealthChecker implements ProviderHealthChecker {
  async validate(account: ChannelAccount): Promise<ValidationResult> {
    // 1. Verificar que el authDir existe y tiene credenciales
    // 2. Intentar conectar vía BaileysSocketManager (si no está conectado)
    // 3. Verificar connection state
    // 4. Si conectado: status 'active', descubrir phoneNumber/wid
    // 5. Si no conectado pero auth existe: status 'auth_expired'
    // 6. Si no hay auth: status 'unchecked' + detail 'QR scan required'
  }
}
```

---

## Paso 9 — Integrar en el Bootstrap

### Archivo: `src/index.ts`

```typescript
import { BaileysAdapter } from './adapters/whatsapp/baileys/baileys.adapter.js';
import { BaileysHealthChecker } from './adapters/whatsapp/baileys/baileys.health-checker.js';

// En main():
adapterFactory.register('baileys', BaileysAdapter);
healthCheckerRegistry.register('baileys', new BaileysHealthChecker());
```

---

## Paso 10 — Registrar listener de mensajes inbound

### Archivo: `src/index.ts` (nuevo bloque después de crear el server)

Para las cuentas Baileys, necesitamos iniciar las conexiones WebSocket y registrar los handlers de mensajes inbound:

```typescript
// Después de crear el server y antes de listen:
import { baileysSocketManager } from './adapters/whatsapp/baileys/baileys-socket.manager.js';

// Conectar todas las cuentas Baileys activas
const baileysAccounts = accounts.filter(a => a.provider === 'baileys' && a.status === 'active');
for (const account of baileysAccounts) {
  await baileysSocketManager.connect(account.id, account.providerConfig as BaileysProviderConfig);

  // Registrar handler de mensajes inbound
  baileysSocketManager.onMessage(account.id, async (event) => {
    const webhookAdapter = new BaileysWebhookAdapter();
    for (const msg of event.messages) {
      if (msg.key.fromMe) continue; // Ignorar mensajes propios
      const waEvent = mapBaileysToWhatsAppEvent(msg);
      const envelope = webhookAdapter.toEnvelope(waEvent, account);
      await webhookForwarder.forward(envelope);
    }
  });
}
```

---

## Paso 11 — Actualizar el webhook controller de WhatsApp

### Archivo: `src/infrastructure/api/webhooks/whatsapp-webhook.controller.ts`

Añadir soporte para que cuentas Baileys puedan recibir webhooks HTTP también (para setups donde Baileys corre en otro proceso y envía webhooks):

```typescript
// En el handler de inbound, detectar si la cuenta es baileys y usar el adapter correcto:
const webhookAdapter = account.provider === 'baileys'
  ? new BaileysWebhookAdapter()
  : new WwebjsWebhookAdapter();
```

---

## Paso 12 — Tests

### Nuevos archivos de test:

**`tests/unit/adapters/baileys-mapper.test.ts`**
- Testear `mapBaileysToWhatsAppEvent()` con todos los tipos de mensaje
- Testear que produce `WhatsAppInboundEvent` compatible con los tipos existentes
- Testear `buildWhatsAppEnvelope()` con eventos Baileys

**`tests/unit/adapters/baileys-adapter.test.ts`**
- Mock del `BaileysSocketManager`
- Testear `sendMessage()` para cada tipo de contenido
- Testear `markAsRead()`
- Testear error handling cuando no hay socket conectado

**Patrón de testing**: Mockear `makeWASocket` y el socket manager. Nunca conectar a WhatsApp real en tests.

---

## Paso 13 — Documentación de configuración

### Ejemplo de `accounts.yaml`:
```yaml
accounts:
  - id: wa-baileys-main
    alias: "WhatsApp Baileys"
    channel: whatsapp
    provider: baileys
    credentialsRef: BAILEYS_MAIN
    providerConfig:
      authDir: "data/baileys-auth/wa-baileys-main"
      printQRInTerminal: true
      browser: ["MessagingGateway", "Chrome", "1.0.0"]
      retryOnDisconnect: true
      maxRetries: 5
    metadata:
      owner: my-team
      environment: production
      tags: [whatsapp, baileys]
```

### Variables de entorno (`.env.example`):
```
# Baileys: ruta al directorio de auth (opcional, usa providerConfig.authDir por defecto)
BAILEYS_MAIN_AUTH_DIR=data/baileys-auth/wa-baileys-main
```

---

## Resumen de archivos

### Nuevos (6 archivos):
| Archivo | Propósito |
|---------|-----------|
| `src/adapters/whatsapp/baileys/baileys.types.ts` | Tipos de configuración y payloads |
| `src/adapters/whatsapp/baileys/baileys-socket.manager.ts` | Gestor de conexiones WebSocket (singleton) |
| `src/adapters/whatsapp/baileys/baileys.adapter.ts` | Implementación de MessagingPort |
| `src/adapters/whatsapp/baileys/baileys.mapper.ts` | Mapeo WAMessage → WhatsAppInboundEvent |
| `src/adapters/whatsapp/baileys/baileys-webhook.adapter.ts` | Implementación de InboundWebhookPort |
| `src/adapters/whatsapp/baileys/baileys.health-checker.ts` | Health checker |

### Nuevos tests (2 archivos):
| Archivo | Propósito |
|---------|-----------|
| `tests/unit/adapters/baileys-mapper.test.ts` | Tests del mapper |
| `tests/unit/adapters/baileys-adapter.test.ts` | Tests del adapter |

### Modificados (4 archivos):
| Archivo | Cambio |
|---------|--------|
| `src/domain/messaging/channel.types.ts` | Añadir `'baileys'` a `ProviderType` |
| `src/infrastructure/config/accounts.schema.ts` | Añadir `'baileys'` al schema Zod |
| `src/infrastructure/config/env.config.ts` | Añadir mapeo de credenciales |
| `src/index.ts` | Registrar adapter, health checker, y conexiones Baileys |

### Dependencia nueva:
```
@whiskeysockets/baileys@^7.0.0-rc.9
```

---

## Orden de implementación recomendado

1. Paso 1: Registrar ProviderType (3 archivos, cambios mínimos)
2. Paso 2: Instalar dependencia
3. Paso 3: Crear tipos (`baileys.types.ts`)
4. Paso 4: Crear socket manager (`baileys-socket.manager.ts`) — componente central
5. Paso 5: Crear adapter (`baileys.adapter.ts`)
6. Paso 6: Crear mapper (`baileys.mapper.ts`)
7. Paso 7: Crear webhook adapter (`baileys-webhook.adapter.ts`)
8. Paso 8: Crear health checker (`baileys.health-checker.ts`)
9. Paso 9-10: Integrar en bootstrap (`index.ts`)
10. Paso 11: Actualizar webhook controller
11. Paso 12: Tests
12. Paso 13: Documentación
13. Verificar: `npm run lint && npm test && npm run build`
