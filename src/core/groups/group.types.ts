export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
  participants: GroupParticipant[];
  createdAt?: string;
  createdBy?: string;
  isAnnouncement: boolean;
}

export interface GroupParticipant {
  id: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}
