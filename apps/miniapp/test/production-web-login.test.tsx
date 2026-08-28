import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCTION_API_BASE_URL } from '../src/lib/api-base-url';
import { WebZaloLoginLink } from '../src/components/WebZaloLoginLink';

test('production web Zalo login is a same-tab anchor with no click handler', () => {
  const element = WebZaloLoginLink({ href: `${PRODUCTION_API_BASE_URL}/auth/zalo/start` });

  assert.equal(element.type, 'a');
  assert.equal(element.props.href, 'https://eco-oil-api.onrender.com/api/v1/auth/zalo/start');
  assert.equal(element.props.target, undefined);
  assert.equal(element.props.onClick, undefined);
  assert.equal(element.props.onClickCapture, undefined);
});
