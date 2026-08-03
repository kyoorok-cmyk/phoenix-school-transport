interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  color?: string;
}

export function StatsCard({ title, value, subtitle, color = '#8B1A2B' }: StatsCardProps) {
  return (
    <div style={{
      background: '#fff',
      borderRadius: '12px',
      padding: '20px',
      border: '1px solid #E2E8F0',
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      borderTop: `3px solid ${color}`,
    }}>
      <p style={{ fontSize: '11px', color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
        {title}
      </p>
      <p style={{ fontSize: '28px', fontWeight: 800, color: '#0F172A', letterSpacing: '-0.02em' }}>
        {value}
      </p>
      {subtitle && (
        <p style={{ fontSize: '11px', color: '#94A3B8', marginTop: '6px' }}>{subtitle}</p>
      )}
    </div>
  );
}
