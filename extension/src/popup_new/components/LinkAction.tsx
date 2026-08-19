import React from 'react';

export const LinkAction: React.FC<{
  children: React.ReactNode;
  onClick?: () => void;
  /** Match the surrounding copy when this sits inline in a hint line rather
   *  than standing alone as a panel action. */
  size?: number;
}> = ({ children, onClick, size = 13 }) => (
  <a
    href="#"
    onClick={(e) => {
      e.preventDefault();
      onClick?.();
    }}
    style={{
      fontSize: size,
      fontWeight: 400,
      color: 'rgba(18,26,48,.78)',
      textDecoration: 'none',
      letterSpacing: '-0.005em',
      textShadow: '0 1px 0 rgba(255,255,255,.55)',
      transition: 'opacity .15s',
    }}
    onMouseEnter={(e) => (e.currentTarget.style.opacity = '.6')}
    onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
  >
    {children}
  </a>
);
