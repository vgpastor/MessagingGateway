import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class MessagingGatewayApi implements ICredentialType {
	name = 'messagingGatewayApi';
	displayName = 'Messaging Gateway API';
	documentationUrl = 'https://github.com/vgpastor/MessagingGateway';
	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:3123',
			placeholder: 'https://gateway.example.com',
			description: 'The base URL of your Messaging Gateway instance (without trailing slash)',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'API key for authentication',
		},
	];
}
