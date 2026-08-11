export interface IZaloAuthProvider {
  verify(code: string): Promise<{ zaloId: string; phone: string; name?: string }>;
}
