/**
 * The whole component kit. No UI library: the app needs maybe eight widgets,
 * and the styling lives in `styles.css` where it can be read as one system.
 */

import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

type ButtonVariant = "default" | "primary" | "ghost" | "danger";

export function Button({
  variant = "default",
  size,
  block,
  busy,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm";
  block?: boolean;
  busy?: boolean;
}) {
  const classes = [
    "btn",
    variant !== "default" && `btn--${variant}`,
    size === "sm" && "btn--sm",
    block && "btn--block",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={classes} {...rest} disabled={rest.disabled || busy}>
      {busy && <span className="spinner" />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      {label && <span className="field__label">{label}</span>}
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ""}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea spellCheck={false} {...props} className={`textarea ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`select ${props.className ?? ""}`} />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="segmented__item"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Banner({
  kind = "info",
  children,
  detail,
  onDismiss,
}: {
  kind?: "info" | "warn" | "error" | "success";
  children: ReactNode;
  detail?: string;
  onDismiss?: () => void;
}) {
  return (
    <div className={`banner banner--${kind}`} role={kind === "error" ? "alert" : "status"}>
      <div className="banner__body">
        <div>{children}</div>
        {detail && <pre className="banner__detail selectable">{detail}</pre>}
      </div>
      {onDismiss && (
        <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </Button>
      )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Pill({
  tone,
  children,
}: {
  tone?: "accent" | "good" | "bad";
  children: ReactNode;
}) {
  return <span className={`pill ${tone ? `pill--${tone}` : ""}`}>{children}</span>;
}
