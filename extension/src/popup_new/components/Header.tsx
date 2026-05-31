import React from 'react';
import { Etched } from './Etched';

export const Header: React.FC = () => (
  <div
    style={{
      padding: '14px 18px 12px',
      display: 'flex',
      alignItems: 'baseline',
      gap: 10,
    }}
  >
    <Etched size={18} weight={500}>
      Actually
    </Etched>
    <Etched
      size={14}
      weight={400}
      italic
      family="serif"
      color="rgba(35,45,70,.55)"
    >
      What do markets really think?
    </Etched>
  </div>
);
