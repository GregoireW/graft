export interface ConsoleUser {
  login: string;
  id: number;
}

export interface EnabledRepository {
  id: number;
  fullName: string;
  canAdmin: boolean;
  enabledBy: string;
  enabledAt: string;
}

export interface RepositoriesResponse {
  filtering: boolean;
  repositories: EnabledRepository[];
  accounts: string[];
  next: number | null;
}

export interface RepositorySearchResponse {
  repositories: { id: number; fullName: string; canAdmin: boolean; enabled: boolean }[];
  next: number | null;
  incomplete: boolean;
}
