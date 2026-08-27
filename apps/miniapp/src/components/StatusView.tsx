interface StatusViewProps {
  title: string;
  message?: string;
  action?: { label: string; onClick: () => void };
}

export function StatusView({ title, message, action }: StatusViewProps) {
  return (
    <div className="status-view" role="status">
      <div className="status-icon">•</div>
      <h2>{title}</h2>
      {message ? <p>{message}</p> : null}
      {action ? <button onClick={action.onClick}>{action.label}</button> : null}
    </div>
  );
}
