import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

export class MessagingGateway implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Messaging Gateway',
		name: 'messagingGateway',
		icon: 'file:messaging-gateway.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Interact with Unified Messaging Gateway — send messages, manage accounts, groups, and webhooks',
		defaults: { name: 'Messaging Gateway' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'messagingGatewayApi',
				required: true,
			},
		],
		properties: [
			// ── Resource selector ──
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Message', value: 'message' },
					{ name: 'Account', value: 'account' },
					{ name: 'Group', value: 'group' },
					{ name: 'Webhook', value: 'webhook' },
				],
				default: 'message',
			},

			// ── Message operations ──
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{ name: 'Send', value: 'send', description: 'Send a message', action: 'Send a message' },
					{ name: 'Get Status', value: 'getStatus', description: 'Get message delivery status', action: 'Get message status' },
					{ name: 'Query', value: 'query', description: 'Query stored messages (requires STORAGE_ENABLED)', action: 'Query messages' },
					{ name: 'Search', value: 'search', description: 'Full-text search messages (requires STORAGE_ENABLED)', action: 'Search messages' },
					{ name: 'Analytics', value: 'analytics', description: 'Get message analytics (requires STORAGE_ENABLED)', action: 'Get message analytics' },
					{ name: 'Export', value: 'export', description: 'Export messages as CSV or JSON (requires STORAGE_ENABLED)', action: 'Export messages' },
					{ name: 'Conversation Context', value: 'conversationContext', description: 'Get AI-ready conversation context (requires STORAGE_ENABLED)', action: 'Get conversation context' },
				],
				default: 'send',
			},

			// ── Account operations ──
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{ name: 'List', value: 'list', description: 'List all accounts', action: 'List all accounts' },
					{ name: 'Get', value: 'get', description: 'Get account details', action: 'Get an account' },
					{ name: 'Connect', value: 'connect', description: 'Connect an account (start session)', action: 'Connect an account' },
					{ name: 'Disconnect', value: 'disconnect', description: 'Disconnect an account', action: 'Disconnect an account' },
				],
				default: 'list',
			},

			// ── Group operations ──
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['group'] } },
				options: [
					{ name: 'List', value: 'list', description: 'List groups for an account', action: 'List groups' },
					{ name: 'Get', value: 'get', description: 'Get group info', action: 'Get a group' },
				],
				default: 'list',
			},

			// ── Webhook operations ──
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['webhook'] } },
				options: [
					{ name: 'List', value: 'list', description: 'List webhooks', action: 'List webhooks' },
					{ name: 'Add', value: 'add', description: 'Add a webhook', action: 'Add a webhook' },
					{ name: 'Remove', value: 'remove', description: 'Remove a webhook', action: 'Remove a webhook' },
				],
				default: 'list',
			},

			// ── Message: Send fields ──
			{
				displayName: 'Account ID',
				name: 'accountId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'wa-main',
				description: 'The account ID to send the message from',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'string',
				required: true,
				default: '',
				placeholder: '+34612345678',
				description: 'Recipient identifier (phone number, chat ID, email, etc.)',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'Content Type',
				name: 'contentType',
				type: 'options',
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'Image', value: 'image' },
					{ name: 'Video', value: 'video' },
					{ name: 'Document', value: 'document' },
					{ name: 'Location', value: 'location' },
				],
				default: 'text',
				description: 'The type of content to send',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Text body of the message',
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], contentType: ['text'] },
				},
			},
			{
				displayName: 'Media URL',
				name: 'mediaUrl',
				type: 'string',
				default: '',
				description: 'URL of the media file to send',
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], contentType: ['image', 'video', 'document'] },
				},
			},
			{
				displayName: 'Caption',
				name: 'caption',
				type: 'string',
				default: '',
				description: 'Caption for the media',
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], contentType: ['image', 'video', 'document'] },
				},
			},
			{
				displayName: 'MIME Type',
				name: 'mimeType',
				type: 'string',
				default: '',
				placeholder: 'application/pdf',
				description: 'MIME type of the document',
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], contentType: ['document'] },
				},
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				description: 'File name for the document',
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], contentType: ['document'] },
				},
			},
			{
				displayName: 'Latitude',
				name: 'latitude',
				type: 'number',
				default: 0,
				description: 'Latitude of the location',
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], contentType: ['location'] },
				},
			},
			{
				displayName: 'Longitude',
				name: 'longitude',
				type: 'number',
				default: 0,
				description: 'Longitude of the location',
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], contentType: ['location'] },
				},
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
				options: [
					{
						displayName: 'Reply to Message ID',
						name: 'replyToMessageId',
						type: 'string',
						default: '',
						description: 'ID of the message to reply to',
					},
				],
			},

			// ── Message: Get Status fields ──
			{
				displayName: 'Account ID',
				name: 'accountId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'wa-main',
				description: 'The account ID that sent the message',
				displayOptions: { show: { resource: ['message'], operation: ['getStatus'] } },
			},
			{
				displayName: 'Message ID',
				name: 'messageId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the message to check status for',
				displayOptions: { show: { resource: ['message'], operation: ['getStatus'] } },
			},

			// ── Message: Query fields ──
			{
				displayName: 'Query Filters',
				name: 'queryFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['query'] } },
				options: [
					{
						displayName: 'Account ID',
						name: 'accountId',
						type: 'string',
						default: '',
						description: 'Filter by account ID',
					},
					{
						displayName: 'Conversation ID',
						name: 'conversationId',
						type: 'string',
						default: '',
						description: 'Filter by conversation ID (e.g. 34600000001@s.whatsapp.net)',
					},
					{
						displayName: 'Direction',
						name: 'direction',
						type: 'options',
						options: [
							{ name: 'All', value: '' },
							{ name: 'Inbound', value: 'inbound' },
							{ name: 'Outbound', value: 'outbound' },
						],
						default: '',
						description: 'Filter by message direction',
					},
					{
						displayName: 'Content Type',
						name: 'contentType',
						type: 'string',
						default: '',
						description: 'Filter by content type (text, image, video, etc.)',
					},
					{
						displayName: 'Since',
						name: 'since',
						type: 'dateTime',
						default: '',
						description: 'Only messages after this timestamp',
					},
					{
						displayName: 'Until',
						name: 'until',
						type: 'dateTime',
						default: '',
						description: 'Only messages before this timestamp',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						default: 50,
						description: 'Max number of messages to return',
					},
					{
						displayName: 'Offset',
						name: 'offset',
						type: 'number',
						default: 0,
						description: 'Number of messages to skip',
					},
				],
			},

			// ── Message: Search fields ──
			{
				displayName: 'Search Query',
				name: 'searchQuery',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'order refund',
				description: 'Full-text search query',
				displayOptions: { show: { resource: ['message'], operation: ['search'] } },
			},
			{
				displayName: 'Search Options',
				name: 'searchOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['search'] } },
				options: [
					{
						displayName: 'Account ID',
						name: 'accountId',
						type: 'string',
						default: '',
						description: 'Filter search by account ID',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						default: 50,
						description: 'Max number of results',
					},
				],
			},

			// ── Message: Analytics fields ──
			{
				displayName: 'Analytics Options',
				name: 'analyticsOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['analytics'] } },
				options: [
					{
						displayName: 'Account ID',
						name: 'accountId',
						type: 'string',
						default: '',
						description: 'Filter analytics by account ID',
					},
					{
						displayName: 'Since',
						name: 'since',
						type: 'dateTime',
						default: '',
						description: 'Start date for analytics period',
					},
					{
						displayName: 'Until',
						name: 'until',
						type: 'dateTime',
						default: '',
						description: 'End date for analytics period',
					},
				],
			},

			// ── Message: Export fields ──
			{
				displayName: 'Export Format',
				name: 'exportFormat',
				type: 'options',
				options: [
					{ name: 'JSON', value: 'json' },
					{ name: 'CSV', value: 'csv' },
				],
				default: 'json',
				description: 'Export format',
				displayOptions: { show: { resource: ['message'], operation: ['export'] } },
			},
			{
				displayName: 'Export Options',
				name: 'exportOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['export'] } },
				options: [
					{
						displayName: 'Account ID',
						name: 'accountId',
						type: 'string',
						default: '',
						description: 'Filter export by account ID',
					},
					{
						displayName: 'Since',
						name: 'since',
						type: 'dateTime',
						default: '',
						description: 'Only export messages after this date',
					},
				],
			},

			// ── Message: Conversation Context fields ──
			{
				displayName: 'Conversation ID',
				name: 'conversationId',
				type: 'string',
				required: true,
				default: '',
				placeholder: '34600000001@s.whatsapp.net',
				description: 'The conversation ID to retrieve context for',
				displayOptions: { show: { resource: ['message'], operation: ['conversationContext'] } },
			},
			{
				displayName: 'Context Options',
				name: 'contextOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['conversationContext'] } },
				options: [
					{
						displayName: 'Format',
						name: 'format',
						type: 'options',
						options: [
							{ name: 'OpenAI (role-based)', value: 'openai' },
							{ name: 'Raw (full envelopes)', value: 'raw' },
						],
						default: 'openai',
						description: 'Output format for AI consumption',
					},
					{
						displayName: 'Account ID',
						name: 'accountId',
						type: 'string',
						default: '',
						description: 'Filter by account ID',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						default: 50,
						description: 'Max number of messages to include',
					},
					{
						displayName: 'Since',
						name: 'since',
						type: 'dateTime',
						default: '',
						description: 'Only messages after this timestamp',
					},
				],
			},

			// ── Account: shared Account ID field ──
			{
				displayName: 'Account ID',
				name: 'accountId',
				type: 'string',
				required: true,
				default: '',
				description: 'The account ID',
				displayOptions: {
					show: { resource: ['account'], operation: ['get', 'connect', 'disconnect'] },
				},
			},

			// ── Group fields ──
			{
				displayName: 'Account ID',
				name: 'accountId',
				type: 'string',
				required: true,
				default: '',
				description: 'The account ID to list or query groups for',
				displayOptions: { show: { resource: ['group'] } },
			},
			{
				displayName: 'Group ID',
				name: 'groupId',
				type: 'string',
				required: true,
				default: '',
				description: 'The group ID to retrieve info for',
				displayOptions: { show: { resource: ['group'], operation: ['get'] } },
			},

			// ── Webhook fields ──
			{
				displayName: 'Account ID',
				name: 'accountId',
				type: 'string',
				default: '',
				description: 'Filter webhooks by account ID (leave empty for all)',
				displayOptions: { show: { resource: ['webhook'], operation: ['list'] } },
			},
			{
				displayName: 'Account ID',
				name: 'accountId',
				type: 'string',
				required: true,
				default: '',
				description: 'The account ID to add the webhook to',
				displayOptions: { show: { resource: ['webhook'], operation: ['add'] } },
			},
			{
				displayName: 'Webhook URL',
				name: 'webhookUrl',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com/webhook',
				description: 'The URL the gateway will POST events to',
				displayOptions: { show: { resource: ['webhook'], operation: ['add'] } },
			},
			{
				displayName: 'Events',
				name: 'webhookEvents',
				type: 'multiOptions',
				default: ['message.inbound'],
				options: [
					{ name: 'Inbound Message', value: 'message.inbound' },
					{ name: 'Message Status', value: 'message.status' },
					{ name: 'Connection Update', value: 'connection.update' },
				],
				description: 'Events to subscribe to',
				displayOptions: { show: { resource: ['webhook'], operation: ['add'] } },
			},
			{
				displayName: 'Webhook ID',
				name: 'webhookId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the webhook to remove',
				displayOptions: { show: { resource: ['webhook'], operation: ['remove'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const credentials = await this.getCredentials('messagingGatewayApi');
		const baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');
		const apiKey = credentials.apiKey as string;

		const headers: Record<string, string> = {
			'X-API-Key': apiKey,
			'Content-Type': 'application/json',
		};

		for (let i = 0; i < items.length; i++) {
			try {
				let responseData: unknown;

				// ── Message ──
				if (resource === 'message') {
					if (operation === 'send') {
						const contentType = this.getNodeParameter('contentType', i) as string;
						const content: Record<string, unknown> = { type: contentType };

						if (contentType === 'text') {
							content.body = this.getNodeParameter('body', i) as string;
						} else if (contentType === 'location') {
							content.latitude = this.getNodeParameter('latitude', i) as number;
							content.longitude = this.getNodeParameter('longitude', i) as number;
						} else {
							content.mediaUrl = this.getNodeParameter('mediaUrl', i) as string;
							const caption = this.getNodeParameter('caption', i, '') as string;
							if (caption) content.caption = caption;
							if (contentType === 'document') {
								const mimeType = this.getNodeParameter('mimeType', i, '') as string;
								const fileName = this.getNodeParameter('fileName', i, '') as string;
								if (mimeType) content.mimeType = mimeType;
								if (fileName) content.fileName = fileName;
							}
						}

						const additionalFields = this.getNodeParameter('additionalFields', i, {}) as {
							replyToMessageId?: string;
						};

						const body: Record<string, unknown> = {
							from: this.getNodeParameter('accountId', i) as string,
							to: this.getNodeParameter('to', i) as string,
							content,
						};

						if (additionalFields.replyToMessageId) {
							body.replyToMessageId = additionalFields.replyToMessageId;
						}

						responseData = await this.helpers.httpRequest({
							method: 'POST',
							url: `${baseUrl}/api/v1/messages/send`,
							headers,
							body,
						});
					} else if (operation === 'getStatus') {
						const messageId = this.getNodeParameter('messageId', i) as string;
						const accountId = this.getNodeParameter('accountId', i) as string;
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/messages/${messageId}/status?accountId=${accountId}`,
							headers,
						});
					} else if (operation === 'query') {
						const filters = this.getNodeParameter('queryFilters', i, {}) as Record<string, unknown>;
						const params = new URLSearchParams();
						for (const [key, value] of Object.entries(filters)) {
							if (value !== undefined && value !== '') params.set(key, String(value));
						}
						const qs = params.toString();
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/messages${qs ? `?${qs}` : ''}`,
							headers,
						});
					} else if (operation === 'search') {
						const q = this.getNodeParameter('searchQuery', i) as string;
						const opts = this.getNodeParameter('searchOptions', i, {}) as Record<string, unknown>;
						const params = new URLSearchParams({ q });
						if (opts.accountId) params.set('accountId', String(opts.accountId));
						if (opts.limit !== undefined && opts.limit !== '') params.set('limit', String(opts.limit));
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/messages/search?${params.toString()}`,
							headers,
						});
					} else if (operation === 'analytics') {
						const opts = this.getNodeParameter('analyticsOptions', i, {}) as Record<string, unknown>;
						const params = new URLSearchParams();
						if (opts.accountId) params.set('accountId', String(opts.accountId));
						if (opts.since) params.set('since', String(opts.since));
						if (opts.until) params.set('until', String(opts.until));
						const qs = params.toString();
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/messages/analytics${qs ? `?${qs}` : ''}`,
							headers,
						});
					} else if (operation === 'export') {
						const format = this.getNodeParameter('exportFormat', i) as string;
						const opts = this.getNodeParameter('exportOptions', i, {}) as Record<string, unknown>;
						const params = new URLSearchParams({ format });
						if (opts.accountId) params.set('accountId', String(opts.accountId));
						if (opts.since) params.set('since', String(opts.since));
						const qs = params.toString();
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/messages/export${qs ? `?${qs}` : ''}`,
							headers,
						});
					} else if (operation === 'conversationContext') {
						const conversationId = this.getNodeParameter('conversationId', i) as string;
						const opts = this.getNodeParameter('contextOptions', i, {}) as Record<string, unknown>;
						const params = new URLSearchParams();
						if (opts.format) params.set('format', String(opts.format));
						if (opts.accountId) params.set('accountId', String(opts.accountId));
						if (opts.limit !== undefined && opts.limit !== '') params.set('limit', String(opts.limit));
						if (opts.since) params.set('since', String(opts.since));
						const qs = params.toString();
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/conversations/${conversationId}/context${qs ? `?${qs}` : ''}`,
							headers,
						});
					}
				}

				// ── Account ──
				if (resource === 'account') {
					if (operation === 'list') {
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/accounts`,
							headers,
						});
					} else if (operation === 'get') {
						const accountId = this.getNodeParameter('accountId', i) as string;
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/accounts/${accountId}`,
							headers,
						});
					} else if (operation === 'connect') {
						const accountId = this.getNodeParameter('accountId', i) as string;
						responseData = await this.helpers.httpRequest({
							method: 'POST',
							url: `${baseUrl}/api/v1/accounts/${accountId}/connect`,
							headers,
						});
					} else if (operation === 'disconnect') {
						const accountId = this.getNodeParameter('accountId', i) as string;
						responseData = await this.helpers.httpRequest({
							method: 'POST',
							url: `${baseUrl}/api/v1/accounts/${accountId}/disconnect`,
							headers,
						});
					}
				}

				// ── Group ──
				if (resource === 'group') {
					const accountId = this.getNodeParameter('accountId', i) as string;
					if (operation === 'list') {
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/accounts/${accountId}/groups`,
							headers,
						});
					} else if (operation === 'get') {
						const groupId = this.getNodeParameter('groupId', i) as string;
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url: `${baseUrl}/api/v1/accounts/${accountId}/groups/${groupId}`,
							headers,
						});
					}
				}

				// ── Webhook ──
				if (resource === 'webhook') {
					if (operation === 'list') {
						const accountId = this.getNodeParameter('accountId', i, '') as string;
						const url = accountId
							? `${baseUrl}/api/v1/accounts/${accountId}/webhooks`
							: `${baseUrl}/api/v1/webhooks`;
						responseData = await this.helpers.httpRequest({
							method: 'GET',
							url,
							headers,
						});
					} else if (operation === 'add') {
						const accountId = this.getNodeParameter('accountId', i) as string;
						const webhookUrl = this.getNodeParameter('webhookUrl', i) as string;
						const events = this.getNodeParameter('webhookEvents', i, []) as string[];
						responseData = await this.helpers.httpRequest({
							method: 'POST',
							url: `${baseUrl}/api/v1/accounts/${accountId}/webhooks`,
							headers,
							body: { url: webhookUrl, events },
						});
					} else if (operation === 'remove') {
						const webhookId = this.getNodeParameter('webhookId', i) as string;
						responseData = await this.helpers.httpRequest({
							method: 'DELETE',
							url: `${baseUrl}/api/v1/webhooks/${webhookId}`,
							headers,
						});
					}
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(responseData as IDataObject),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
