export function Brand({ desktop = false }: { desktop?: boolean }) {
  const version = desktop ? import.meta.env?.VITE_DESKTOP_APP_VERSION : undefined;
  const preview = desktop && import.meta.env?.VITE_DESKTOP_APP_CHANNEL === 'preview';
  return <div className="brand" aria-label={desktop ? 'bizencore terminal squared' : 'bizencore terminal'}><span className="brand-bizen">bizen</span><i>core</i><span className="brand-product">terminal{desktop ? <sup className="brand-power" aria-hidden="true">2</sup> : null}</span>{version ? <span className="brand-version">v{version}{preview ? ' · Preview' : ''}</span> : null}</div>;
}
