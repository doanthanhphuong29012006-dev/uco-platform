import assert from 'node:assert/strict';
import test from 'node:test';
import { OilGrade } from '@eco-oil/shared-types';
import { GradePhotoPicker, isGradePhotoMissing } from '../src/components/GradePhotoPicker';
import { OilGradeSelector } from '../src/components/OilGradeSelector';

function findElement(node: unknown, type: string): { props: { onChange?: (event: { target: { files: File[]; value: string } }) => void } } | null {
  if (!node || typeof node !== 'object') return null;
  const element = node as { type?: string; props?: { children?: unknown } };
  if (element.type === type) return element as { props: { onChange?: (event: { target: { files: File[]; value: string } }) => void } };
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElement(child, type);
      if (found) return found;
    }
  } else {
    return findElement(children, type);
  }
  return null;
}

function findElementByClass(node: unknown, className: string): { props: { disabled?: boolean } } | null {
  if (!node || typeof node !== 'object') return null;
  const element = node as { props?: { className?: string; children?: unknown } };
  if (element.props?.className === className) return element as { props: { disabled?: boolean } };
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElementByClass(child, className);
      if (found) return found;
    }
  } else {
    return findElementByClass(children, className);
  }
  return null;
}

test('grade C file picker sends the selected file through the UI handler', () => {
  let selectedGrade: OilGrade | null = null;
  const gradeView = OilGradeSelector({ value: null, disabled: false, onChange: (grade) => { selectedGrade = grade; } });
  const gradeButtons = gradeView.props.children as Array<{ props: { onClick: () => void } }>;
  gradeButtons[2].props.onClick();
  assert.equal(selectedGrade, OilGrade.C);

  const selectedFiles: File[] = [];
  const file = { name: 'grade-c.jpg', type: 'image/jpeg' } as File;
  const view = GradePhotoPicker({
    photos: [],
    busy: false,
    disabled: false,
    onTakePhoto: () => undefined,
    onChooseFile: (selected) => selectedFiles.push(selected),
    onRemovePhoto: () => undefined,
  });
  const input = findElement(view, 'input');
  const event = { target: { files: [file], value: 'selected-file' } };

  input?.props.onChange?.(event);

  assert.equal(selectedFiles[0], file);
  assert.equal(event.target.value, '');
  assert.equal(isGradePhotoMissing(selectedGrade, false, selectedFiles.length), false);
});

test('a selected grade C photo renders a preview and an enabled remove action', () => {
  const view = GradePhotoPicker({
    photos: [{ url: 'data:image/jpeg;base64,photo', width: 80, height: 80 }],
    busy: false,
    disabled: false,
    onTakePhoto: () => undefined,
    onChooseFile: () => undefined,
    onRemovePhoto: () => undefined,
  });
  const previewList = findElementByClass(view, 'photo-preview-list');
  const removeButton = findElementByClass(view, 'photo-remove-button');

  assert.ok(previewList);
  assert.equal(removeButton?.props.disabled, false);
});
