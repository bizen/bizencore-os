import { MessagesSquare, Play } from 'lucide-react';
import type { HandoffIntent } from '../../lib/taskWorkPrompt';

export function HandoffIntentControl({ intent, onChange, disabled = false }: {
  intent: HandoffIntent;
  onChange: (intent: HandoffIntent) => void;
  disabled?: boolean;
}) {
  return <div className="handoff-option">
    <span className="handoff-option-label">進め方</span>
    <div className="inspector-handoff-mode" role="group" aria-label="AIの進め方">
      <button type="button" className={intent === 'consult' ? 'is-on' : ''} aria-pressed={intent === 'consult'} disabled={disabled} onClick={() => onChange('consult')}><MessagesSquare size={14} aria-hidden />検討する</button>
      <button type="button" className={intent === 'execute' ? 'is-on' : ''} aria-pressed={intent === 'execute'} disabled={disabled} onClick={() => onChange('execute')}><Play size={14} aria-hidden />実行する</button>
    </div>
  </div>;
}
