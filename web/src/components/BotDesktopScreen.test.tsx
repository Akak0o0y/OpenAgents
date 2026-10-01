import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotDesktopScreen } from './BotDesktopScreen.js';

it('enlarges a single authenticated viewer and returns without ending sign-in', async () => {
  const user = userEvent.setup();
  render(<BotDesktopScreen agentId="alpha" />);
  await user.click(screen.getByRole('button', { name: 'Enlarge desktop' }));
  expect(screen.getByRole('dialog', { name: 'Bot desktop' })).toContainElement(screen.getByTitle('Bot desktop — Chrome'));
  expect(screen.getAllByTitle('Bot desktop — Chrome')).toHaveLength(1);
  expect(screen.getByTitle('Bot desktop — Chrome')).toHaveAttribute('src', '/api/desktop/alpha/viewer.html');
  await user.click(screen.getByRole('button', { name: 'Return to chat' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByTitle('Bot desktop — Chrome')).toBeInTheDocument();
});
