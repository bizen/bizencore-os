export function Brand({ desktop = false }: { desktop?: boolean }) {
  return <div className="brand" aria-label={desktop ? 'bizencore terminal squared' : 'bizencore terminal'}><span className="brand-bizen">bizen</span><i>core</i><span className="brand-product">terminal{desktop ? <sup className="brand-power" aria-hidden="true">2</sup> : null}</span></div>;
}
