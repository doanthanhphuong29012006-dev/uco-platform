import { getAccessToken } from 'zmp-sdk';

export interface IZaloClient {
  getAccessToken(): Promise<string>;
}

class RealZaloClient implements IZaloClient {
  getAccessToken(): Promise<string> {
    return getAccessToken();
  }
}

class DevZaloClient implements IZaloClient {
  async getAccessToken(): Promise<string> {
    throw new Error('Zalo SDK is unavailable in browser development mode');
  }
}

export const zaloClient: IZaloClient = import.meta.env.DEV ? new DevZaloClient() : new RealZaloClient();
