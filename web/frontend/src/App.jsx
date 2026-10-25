import { Routes, Route, Navigate } from 'react-router-dom';
import EntryListPage from './pages/EntryListPage';
import EntryDetailPage from './pages/EntryDetailPage';
import UserPage from './pages/UserPage';
import './App.css';

export default function App() {
  return (
    <Routes>
      <Route path="/entries" element={<EntryListPage />} />
      <Route path="/entries/:entryId" element={<EntryDetailPage />} />
      <Route path="/user" element={<UserPage />} />
      <Route path="*" element={<Navigate to="/entries" replace />} />
    </Routes>
  );
}
