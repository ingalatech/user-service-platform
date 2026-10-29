import englishMessages from 'ra-language-english';
import polyglotI18nProvider from 'ra-i18n-polyglot';

// Version-compatible ra-core fallback; all strings used by this slice are
// translated here. Future resource slices must supply their own Spanish copy.
const messages = {
  ...englishMessages,
  ra: {
    ...englishMessages.ra,
    action: {
      ...englishMessages.ra.action,
      refresh: 'Actualizar',
      back: 'Volver',
      close: 'Cerrar',
      open_menu: 'Abrir menú',
      close_menu: 'Cerrar menú',
      show: 'Ver detalle',
      save: 'Guardar cambios',
      cancel: 'Cancelar',
      search: 'Buscar',
      clear_search: 'Limpiar búsqueda',
    },
    page: {
      ...englishMessages.ra.page,
      dashboard: 'Inicio',
      loading: 'Cargando',
      error: 'Ocurrió un problema',
      not_found: 'Página no encontrada',
    },
    auth: {
      ...englishMessages.ra.auth,
      logout: 'Cerrar sesión',
      user_menu: 'Menú de usuario',
      auth_check_error: 'No pudimos comprobar la sesión',
    },
    message: {
      ...englishMessages.ra.message,
      loading: 'Espera un momento',
      error: 'Inténtalo de nuevo',
      not_found: 'No encontramos esta página',
    },
    navigation: {
      ...englishMessages.ra.navigation,
      page_rows_per_page: 'Filas por página',
      page_range_info: '%{offsetBegin}-%{offsetEnd} de %{total}',
      next: 'Siguiente',
      previous: 'Anterior',
    },
    validation: {
      ...englishMessages.ra.validation,
      required: 'Campo obligatorio',
      email: 'Introduce un correo electrónico válido',
    },
  },
};
export const i18nProvider = polyglotI18nProvider(() => messages, 'es', [
  { name: 'es', value: 'Español' },
]);
