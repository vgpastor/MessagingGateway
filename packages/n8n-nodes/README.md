# n8n-nodes-messaging-gateway

Community nodes for [n8n](https://n8n.io/) to integrate with [Unified Messaging Gateway](https://github.com/vgpastor/MessagingGateway) — send and receive messages across WhatsApp, Telegram, Email, and SMS from your n8n workflows.

## Installation

### In n8n Desktop / Self-hosted

1. Go to **Settings > Community Nodes**
2. Enter `n8n-nodes-messaging-gateway`
3. Click **Install**

### Manual

```bash
cd ~/.n8n
npm install n8n-nodes-messaging-gateway
```

Then restart n8n.

## Configuration

1. In n8n, go to **Credentials > New Credential**
2. Search for **Messaging Gateway API**
3. Enter:
   - **Base URL**: The URL of your Messaging Gateway instance (e.g., `http://localhost:3123`)
   - **API Key**: Your gateway API key

## Nodes

### Messaging Gateway (Action Node)

Perform operations against the Messaging Gateway API.

| Resource | Operation   | Description                             |
|----------|-------------|-----------------------------------------|
| Message  | Send        | Send text, image, video, document, or location messages |
| Message  | Get Status  | Retrieve the delivery status of a sent message |
| Account  | List        | List all configured messaging accounts  |
| Account  | Get         | Get details for a specific account      |
| Account  | Connect     | Start a session / generate QR code      |
| Account  | Disconnect  | Stop an active session                  |
| Group    | List        | List groups for an account              |
| Group    | Get         | Get detailed group information          |
| Webhook  | List        | List registered webhooks                |
| Webhook  | Add         | Register a new webhook endpoint         |
| Webhook  | Remove      | Delete a webhook by ID                  |

### Messaging Gateway Trigger (Trigger Node)

Starts a workflow when the gateway receives an inbound message or event.

1. Add the **Message Received** trigger to your workflow
2. Activate the workflow to obtain the webhook URL
3. Register that URL in your Messaging Gateway via the Webhook > Add operation or the gateway API
4. Incoming messages will trigger the workflow with the full `UnifiedEnvelope` payload

**Supported events:**
- `message.inbound` — New incoming message
- `message.status` — Delivery status update (sent, delivered, read, failed)
- `connection.update` — Account connection state change

## Example Workflows

### Auto-reply to WhatsApp messages

1. **Message Received** trigger (events: `message.inbound`)
2. **IF** node to check `{{$json.content.type}} === 'text'`
3. **Messaging Gateway** Send node to reply with a text message

### Forward Telegram messages to Slack

1. **Message Received** trigger (events: `message.inbound`)
2. **Slack** node to post the message content to a channel

### Monitor account health

1. **Schedule Trigger** (every 5 minutes)
2. **Messaging Gateway** Account > List
3. **IF** node to filter disconnected accounts
4. **Email** node to alert the operations team

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run lint

# Build
npm run build
```

## License

[MIT](LICENSE)
