import { createElement } from 'react';

type WebZaloLoginLinkProps = {
  href: string;
};

export function WebZaloLoginLink({ href }: WebZaloLoginLinkProps) {
  return createElement('a', { className: 'primary-button login-oauth-link', href }, 'Đăng nhập bằng Zalo');
}
