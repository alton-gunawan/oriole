import { Navigate, useParams } from 'react-router';

export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/app/contacts${id ? `?contactId=${encodeURIComponent(id)}` : ''}`} replace />;
}
