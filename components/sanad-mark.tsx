export function SanadMark({ size = 48 }: { size?: number }) {
  const height = size
  const width = Math.round(size * (86 / 48))
  return (
    <svg width={width} height={height} viewBox="0 0 86 48" fill="none" aria-hidden="true">
      <path
        d="M31 12.2c-8.6 0-14.2 3.6-14.2 8.6 0 4.2 4 6.5 10.2 7.5 5.6.9 8.6 2.3 8.6 5.6 0 4-4.8 7-11.6 7-4.4 0-8-1.1-10.2-2.9"
        stroke="currentColor"
        strokeWidth="4.6"
        strokeLinecap="round"
      />
      <path
        d="M49 37.4V17.2c0-4.8 3.5-8 8.4-8s8.4 3.2 8.4 8v20.2"
        stroke="currentColor"
        strokeWidth="4.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
