import { rememberSessionCredentials } from './connection-credentials';
import { buildTransportInvokeFields } from './connection-transport-settings';
import { decryptConnectionSecrets } from './secrets';
import type { ConnectionData } from './connection-storage';

export type Connectable = {
  host: string;
  port?: number;
  username: string;
  authMethod?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyData?: string;
  passphrase?: string;
  proxyType?: string;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  startupCommand?: string;
};

/**
 * Build ssh_connect / sftp_connect request fields from a stored connection.
 * @param profileId Optional profile id used to remember secrets for duplicate/reconnect
 *   when "Save Passwords" is off. Defaults to `connectionId`.
 */
export async function buildSshConnectRequest(
  connectionId: string,
  connection: Connectable,
  profileId?: string,
): Promise<Record<string, unknown>> {
  const secrets = await decryptConnectionSecrets(connection);
  rememberSessionCredentials(profileId || connectionId, secrets);
  const proxyType = secrets.proxyType && secrets.proxyType !== 'none' ? secrets.proxyType : undefined;
  return {
    connection_id: connectionId,
    host: secrets.host,
    port: secrets.port || 22,
    username: secrets.username,
    auth_method: secrets.authMethod || 'password',
    password: secrets.password || '',
    key_path: secrets.privateKeyPath || null,
    key_data: secrets.privateKeyData || null,
    passphrase: secrets.passphrase || null,
    ...buildTransportInvokeFields(),
    proxy_type: proxyType || null,
    proxy_host: secrets.proxyHost || null,
    proxy_port: secrets.proxyPort || null,
    proxy_username: secrets.proxyUsername || null,
    proxy_password: secrets.proxyPassword || null,
    startup_command: secrets.startupCommand || null,
  };
}

export async function buildSshConnectRequestFromData(
  connectionId: string,
  data: ConnectionData,
): Promise<Record<string, unknown>> {
  return buildSshConnectRequest(connectionId, data);
}
