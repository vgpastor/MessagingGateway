import type {
	IWebhookFunctions,
	IWebhookResponseData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

export class MessagingGatewayTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Messaging Gateway Trigger',
		name: 'messagingGatewayTrigger',
		icon: 'file:messaging-gateway.svg',
		group: ['trigger'],
		version: 1,
		description: 'Starts the workflow when a message is received via Messaging Gateway',
		defaults: { name: 'Message Received' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'messagingGatewayApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				default: ['message.inbound'],
				options: [
					{ name: 'Inbound Message', value: 'message.inbound' },
					{ name: 'Message Status', value: 'message.status' },
					{ name: 'Connection Update', value: 'connection.update' },
				],
				description: 'The events to listen for',
			},
		],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();
		const events = this.getNodeParameter('events', []) as string[];

		// If the payload contains an event type, filter by configured events
		const eventType = (body as Record<string, unknown>).event as string | undefined;
		if (eventType && events.length > 0 && !events.includes(eventType)) {
			// Event not subscribed — acknowledge but don't trigger the workflow
			return { noWebhookResponse: true };
		}

		return {
			workflowData: [this.helpers.returnJsonArray(body)],
		};
	}
}
