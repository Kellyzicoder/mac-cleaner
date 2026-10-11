export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" role="img" aria-label="Mac Purificator logo">
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2ee6b0" />
          <stop offset="1" stopColor="#0a6cff" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="30" fill="url(#logo-bg)" />
      <path
        d="M62 24 C65 50 76 62 102 66 C76 70 65 82 62 108 C59 82 48 70 22 66 C48 62 59 50 62 24 Z"
        fill="#ffffff"
      />
      <path
        d="M99 14 C100 22 103 25 111 26 C103 27 100 30 99 38 C98 30 95 27 87 26 C95 25 98 22 99 14 Z"
        fill="#ffffff"
        fillOpacity="0.9"
      />
      <path
        d="M30 94 C31 99 33 101 38 102 C33 103 31 105 30 110 C29 105 27 103 22 102 C27 101 29 99 30 94 Z"
        fill="#ffffff"
        fillOpacity="0.85"
      />
    </svg>
  );
}
