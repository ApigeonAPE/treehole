import { useState } from 'react';
import { toggleFavorite } from '../lib/api';
import './StarButton.css';

export default function StarButton({ entryId, initialFavorited, onToggle }) {
  const [favorited, setFavorited] = useState(initialFavorited || false);
  const [loading, setLoading] = useState(false);

  async function handleClick(e) {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    try {
      const result = await toggleFavorite(entryId);
      setFavorited(result.favorited);
      if (onToggle) onToggle(entryId, result.favorited);
    } catch {} finally {
      setLoading(false);
    }
  }

  return (
    <button
      className={`star-btn ${favorited ? 'star-active' : ''}`}
      onClick={handleClick}
      title={favorited ? 'Remove favorite' : 'Favorite'}
      disabled={loading}
    >
      {favorited ? '★' : '☆'}
    </button>
  );
}
