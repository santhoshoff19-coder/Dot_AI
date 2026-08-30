export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="border-b border-line px-4 py-4 md:px-8">
      <h1 className="text-[18px] font-semibold tracking-tight text-ink">{title}</h1>
      {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
    </header>
  );
}
