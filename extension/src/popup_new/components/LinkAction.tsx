import React from 'react';

export const LinkAction: React.FC<{
  children: React.ReactNode;
  onClick?: () => void;
}> = ({ children, onClick }) => (
  <a
    href="#"
    onClick={(e) => {
      e.preventDefault();
      onClick?.();
    }}
    style={{
      fontSize: 13,
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
