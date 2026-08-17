import assert from 'node:assert/strict';
import test from 'node:test';
import { OilGrade } from '@eco-oil/shared-types';
import { OilGradeSelector } from '../src/components/OilGradeSelector';

test('clicking grade B selects B through the rendered button handler', () => {
  let selected: OilGrade | null = null;
  const view = OilGradeSelector({ value: null, disabled: false, onChange: (grade) => { selected = grade; } });
  const buttons = view.props.children as Array<{ props: { children: Array<unknown>; onClick: () => void } }>;

  buttons[1].props.onClick();

  assert.equal(selected, OilGrade.B);
});

test('clicking grade A changes the selected value through the rendered button handler', () => {
  let selected: OilGrade | null = OilGrade.B;
  const view = OilGradeSelector({ value: OilGrade.B, disabled: false, onChange: (grade) => { selected = grade; } });
  const buttons = view.props.children as Array<{ props: { children: Array<unknown>; onClick: () => void } }>;

  buttons[0].props.onClick();

  assert.equal(selected, OilGrade.A);
});
