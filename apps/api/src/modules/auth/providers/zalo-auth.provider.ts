export interface IZaloAuthProvider {
  exchangeCode(code: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;
  verify(accessToken: string): Promise<ZaloProfile>;
}

export interface ZaloProfile {
  zaloId: string;
  phone: string | null;
  name?: string;
  avatarUrl?: string;
}
