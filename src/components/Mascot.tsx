import { X } from 'lucide-react';
import { useState } from 'react';
import cirnoImg from '../assets/cirno.png';

export function Mascot() {
    const [open, setOpen] = useState(false);

    return (
        <div className="mascot-container">
            {open && (
                <div className="speech-bubble">
                    <button
                        type="button"
                        onClick={() => setOpen(false)}
                        className="close-bubble"
                        aria-label="閉じる"
                    >
                        <X size={16} />
                    </button>
                    <h3 className="speech-bubble-title">bizencore について</h3>
                    <p className="speech-bubble-body">
                        あたいが文字数をかぞえるよ！
                        <br />
                        Let me count the words for you!
                    </p>
                </div>
            )}
            <img
                src={cirnoImg}
                alt="Cirno"
                className="mascot"
                onClick={() => setOpen((v) => !v)}
            />
        </div>
    );
}
