import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' }
})

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Handle 401 responses globally
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// Auth
export const authApi = {
  register: (username, password) => api.post('/auth/register', { username, password }),
  login: (username, password) => api.post('/auth/login', { username, password })
}

// Boards
export const boardApi = {
  list: () => api.get('/boards'),
  create: (name, description) => api.post('/boards', { name, description }),
  delete: (id) => api.delete(`/boards/${id}`),
  export: (id) => api.get(`/boards/${id}/export`, { responseType: 'blob' })
}

// Columns
export const columnApi = {
  list: (boardId) => api.get(`/boards/${boardId}/columns`),
  create: (boardId, name) => api.post(`/boards/${boardId}/columns`, { name }),
  update: (id, data) => api.put(`/columns/${id}`, data),
  delete: (id) => api.delete(`/columns/${id}`)
}

// Cards
export const cardApi = {
  list: (columnId) => api.get(`/columns/${columnId}/cards`),
  create: (columnId, data) => api.post(`/columns/${columnId}/cards`, data),
  update: (id, data) => api.put(`/cards/${id}`, data),
  delete: (id) => api.delete(`/cards/${id}`),
  move: (id, columnId, position) => api.put(`/cards/${id}/move`, { columnId, position })
}

export default api
