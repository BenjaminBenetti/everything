/** The constellation mark from the approved Everything concept. */
export function Brand({ className = "" }: { className?: string }) {
  return (
    <div className={`wordmark ${className}`}>
      <svg
        className="logo"
        viewBox="0 0 40 40"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="m9 8 9 6 13-6M18 14l7 9 11-4M25 23l6 8M25 23l-11 2-6 6M14 25 4 19"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          opacity=".24"
        />
        {[
          [20, 4, 1.9],
          [31, 8, 2.3],
          [36, 19, 1.7],
          [31, 31, 2.4],
          [20, 36, 1.8],
          [8, 31, 2],
          [4, 19, 1.9],
          [9, 8, 1.6],
          [18, 14, 2.7],
          [25, 23, 3.1],
          [14, 25, 2.2],
        ].map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} />
        ))}
      </svg>
      <span>everything</span>
    </div>
  );
}

/** Static routed grid artwork; motion is a decoration, never a loading requirement. */
export function GridArt({ className = "" }: { className?: string }) {
  return (
    <div className={`theme-art ${className}`} aria-hidden="true">
      <svg viewBox="0 0 360 360" fill="none">
        <g stroke="currentColor">
          <path
            d="M0 60h360M0 120h360M0 180h360M0 240h360M0 300h360M60 0v360M120 0v360M180 0v360M240 0v360M300 0v360"
            opacity=".5"
          />
          <path
            className="routed-line"
            d="M60 240v-60h60v-60h120v120h60"
            strokeWidth="2"
          />
          <g fill="currentColor" stroke="none">
            {[
              [55, 235],
              [115, 115],
              [235, 115],
              [295, 235],
            ].map(([x, y], i) => (
              <rect key={i} x={x} y={y} width="10" height="10" />
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}
