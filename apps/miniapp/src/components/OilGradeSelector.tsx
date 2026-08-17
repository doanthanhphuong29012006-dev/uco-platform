import { OilGrade } from '@eco-oil/shared-types';

export function OilGradeSelector({ value, disabled, onChange }: { value: OilGrade | null; disabled: boolean; onChange: (grade: OilGrade) => void }) {
  const options: Array<{ grade: OilGrade; criteria: string }> = [
    { grade: OilGrade.A, criteria: 'Vàng đến nâu nhạt, trong, không lắng cặn, không mùi khét nặng.' },
    { grade: OilGrade.B, criteria: 'Nâu sẫm, hơi đục hoặc có ít cặn lắng, mùi khét rõ.' },
    { grade: OilGrade.C, criteria: 'Đen đặc, nhiều cặn, có nước hoặc vụn thức ăn, mùi hắc.' },
  ];

  return (
    <div className="quality-options grade-options">
      {options.map(({ grade, criteria }) => (
        <button
          key={grade}
          type="button"
          className={value === grade ? 'quality-option grade-option selected' : 'quality-option grade-option'}
          onClick={() => onChange(grade)}
          disabled={disabled}
        >
          <strong>{grade}</strong>
          <small>{criteria}</small>
        </button>
      ))}
    </div>
  );
}
